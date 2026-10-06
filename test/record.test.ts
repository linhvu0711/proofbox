import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Duration,
  Effect,
  Fiber,
  Layer,
  Ref,
  Stream,
  TestClock,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { setMark } from "../src/commands/mark.ts";
import { stopRecording } from "../src/commands/record.ts";
import { CaptureBlockedError, NothingChangedError } from "../src/errors.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type ExecEvent,
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { Style } from "../src/style.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { sleepsNear } from "./support/clock.ts";
import { commandOf, withCall } from "./support/connection.ts";
import { nodeFs } from "./support/node-fs.ts";

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const tempRoots: string[] = [];

// A fake Sandbox that reports itself as a Mac, whose exec answers
// `/opt/proofbox/record stop` with a blocked-capture report and `fetch`
// with one PNG header.
const blockedMac = (root: string, blocked: string): Provider => {
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const answer = (argv: ReadonlyArray<string>) => {
    const [, action, remote] = argv;
    if (action === "stop") {
      return Stream.make(
        {
          _tag: "Stdout" as const,
          bytes: new TextEncoder().encode(
            `{"dir":"/var/lib/proofbox/recordings/1","start":1,"stop":5,"steps":0,"width":1280,"height":800,"blocked":"${blocked}"}`,
          ),
        },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    if (
      action === "fetch" &&
      remote === "/var/lib/proofbox/recordings/1/blocked.png"
    ) {
      return Stream.make(
        { _tag: "Stdout" as const, bytes: PNG_HEAD },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    return Stream.make({ _tag: "Exit" as const, code: 1 });
  };
  return {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) =>
        withCall(connection, (argv) => answer(commandOf(argv))),
      ),
  };
};

// A fake Mac whose Recording ran 300 s (start 1000, stop 1300) and whose
// check (`probe`) answers with `probe`.
const stoppingMac = (
  root: string,
  probe: Stream.Stream<ExecEvent>,
): Provider => {
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const answer = (argv: ReadonlyArray<string>): Stream.Stream<ExecEvent> => {
    const [, action] = argv;
    if (action === "stop") {
      return Stream.make(
        {
          _tag: "Stdout" as const,
          bytes: new TextEncoder().encode(
            '{"dir":"/var/lib/proofbox/recordings/1","start":1000,"stop":1300,"steps":0,"width":1440,"height":900}',
          ),
        },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    if (action === "probe") {
      return probe;
    }
    return Stream.make({ _tag: "Exit" as const, code: 1 });
  };
  return {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) =>
        withCall(connection, (argv) => answer(commandOf(argv))),
      ),
  };
};

// A fake Mac with one Step mark, whose Recording builds and downloads but
// whose Step label cannot be read.
const labelLessMac = (root: string): Provider => {
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const dir = "/var/lib/proofbox/recordings/1";
  const answer = (argv: ReadonlyArray<string>): Stream.Stream<ExecEvent> => {
    const [, action, remote] = argv;
    const text = (body: string) =>
      Stream.make(
        { _tag: "Stdout" as const, bytes: new TextEncoder().encode(body) },
        { _tag: "Exit" as const, code: 0 },
      );
    if (action === "stop") {
      return text(
        `{"dir":"${dir}","start":1000,"stop":1010,"steps":1,"width":1440,"height":900}`,
      );
    }
    if (action === "probe") {
      return text("Duration: 00:00:10.00\n");
    }
    if (action === "build") {
      return text("1000");
    }
    if (action === "fetch" && remote === `${dir}/caption-1.txt`) {
      return Stream.make(
        {
          _tag: "Stderr" as const,
          bytes: new TextEncoder().encode("no such file"),
        },
        { _tag: "Exit" as const, code: 1 },
      );
    }
    if (action === "fetch" && remote?.startsWith(`${dir}/`) === true) {
      return Stream.make(
        { _tag: "Stdout" as const, bytes: PNG_HEAD },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    // The Action log: no actions.
    return text("");
  };
  return {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) =>
        withCall(connection, (argv) => answer(commandOf(argv))),
      ),
  };
};

// A fake Mac whose record helper takes every call with exit 0; `calls` gets
// the argv of each one.
const markingMac = (root: string, calls: string[][]): Provider => {
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const answer = (argv: ReadonlyArray<string>): Stream.Stream<ExecEvent> => {
    calls.push([...argv]);
    return Stream.make({ _tag: "Exit" as const, code: 0 });
  };
  return {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) =>
        withCall(connection, (argv) => answer(commandOf(argv))),
      ),
  };
};

// `terminal`: the look is on. `hints` gets each hint line, and `warnings`
// each warning.
const layers = (
  mac: Provider,
  options: {
    readonly terminal?: boolean;
    readonly hints?: string[];
    readonly warnings?: string[];
  } = {},
) => {
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([["fake", providerEntry(mac)]]),
  );
  const output =
    options.terminal === true ? CliOutput.TestTerminal(100) : CliOutput.Test;
  return Layer.mergeAll(
    NodeContext.layer,
    output,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: (text) =>
          Effect.sync(() => {
            options.warnings?.push(text);
          }),
        note: () => Effect.void,
        done: () => Effect.void,
        hint: (text) =>
          Effect.sync(() => {
            options.hints?.push(text);
          }),
      }),
    ),
    Style.Default.pipe(Layer.provide(output)),
  );
};

describe("Recording and the Proof video", () => {
  afterEach(() => {
    cleanupEnvs();
    // A Deadline push already writing when its call ended can still land
    // a file in the fake root; the retries let that write finish first.
    for (const root of tempRoots.splice(0)) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  effectIt.effect(
    "mark cuts a label over 60 characters to 60 and warns",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const calls: string[][] = [];
      const warnings: string[] = [];
      const mac = markingMac(root, calls);
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        yield* setMark({ id, label: "a".repeat(61), wait: false });
        // Then
        expect({
          marks: calls.filter((argv) => argv[1] === "mark"),
          warnings,
        }).toEqual({
          marks: [
            [
              "/opt/proofbox/record",
              "mark",
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
          ],
          warnings: [
            'Step mark cut to 60 characters: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
          ],
        });
      }).pipe(Effect.provide(layers(mac, { warnings })));
    },
  );

  effectIt.effect(
    "mark --wait cuts a reason over 60 characters to 60 and warns",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const calls: string[][] = [];
      const warnings: string[] = [];
      const mac = markingMac(root, calls);
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        yield* setMark({ id, label: "a".repeat(61), wait: true });
        // Then
        expect({
          waits: calls.filter((argv) => argv[1] === "wait"),
          warnings,
        }).toEqual({
          waits: [
            [
              "/opt/proofbox/record",
              "wait",
              '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
            ],
          ],
          warnings: [
            'Wait mark cut to 60 characters: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
          ],
        });
      }).pipe(Effect.provide(layers(mac, { warnings })));
    },
  );

  effectIt.effect("mark cuts a label at a whole character", () => {
    const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
    tempRoots.push(root);
    const calls: string[][] = [];
    const warnings: string[] = [];
    const mac = markingMac(root, calls);
    return Effect.gen(function* () {
      // Given: the stub Mac above, and 61 characters that are 62 UTF-16 units
      const info = yield* mac.create({
        os: "macos",
        idle: Duration.minutes(5),
        maxLife: Duration.hours(1),
      });
      const id = `fake:${info.name}`;
      // When
      yield* setMark({ id, label: `${"a".repeat(58)}✔👍b`, wait: false });
      // Then
      expect({
        marks: calls.filter((argv) => argv[1] === "mark"),
        warnings,
      }).toEqual({
        marks: [
          [
            "/opt/proofbox/record",
            "mark",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa✔👍",
          ],
        ],
        warnings: [
          'Step mark cut to 60 characters: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa✔👍"',
        ],
      });
    }).pipe(Effect.provide(layers(mac, { warnings })));
  });

  effectIt.effect(
    "mark cuts before an emoji that would cross 60 characters",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const calls: string[][] = [];
      const warnings: string[] = [];
      const mac = markingMac(root, calls);
      return Effect.gen(function* () {
        // Given: the stub Mac above, and a thumbs-up with a skin tone, two
        // code points, at characters 60 and 61
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        yield* setMark({ id, label: `${"a".repeat(59)}👍🏽`, wait: false });
        // Then
        expect({
          marks: calls.filter((argv) => argv[1] === "mark"),
          warnings,
        }).toEqual({
          marks: [
            [
              "/opt/proofbox/record",
              "mark",
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
          ],
          warnings: [
            'Step mark cut to 60 characters: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
          ],
        });
      }).pipe(Effect.provide(layers(mac, { warnings })));
    },
  );

  effectIt.effect(
    "mark cuts by code point when one character is over 60 code points",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const calls: string[][] = [];
      const warnings: string[] = [];
      const mac = markingMac(root, calls);
      return Effect.gen(function* () {
        // Given: the stub Mac above, and an `a` with 60 combining accents,
        // one character of 61 code points
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        yield* setMark({
          id,
          label: `a${"\u0301".repeat(60)}`,
          wait: false,
        });
        // Then: the mark keeps `a` and 59 accents, never an empty label
        expect({
          marks: calls.filter((argv) => argv[1] === "mark"),
          warnings,
        }).toEqual({
          marks: [["/opt/proofbox/record", "mark", `a${"\u0301".repeat(59)}`]],
          warnings: [
            `Step mark cut to 60 characters: "a${"\u0301".repeat(59)}"`,
          ],
        });
      }).pipe(Effect.provide(layers(mac, { warnings })));
    },
  );

  it("mark refuses an empty label", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["mark", id, ""]);
    // Then
    expect({ code: result.exitCode, stderr: result.stderr }).toEqual({
      code: 125,
      stderr:
        'Bad Step mark "": use one line of text, for example "step 3: save the post"\n',
    });
  });

  it("mark refuses a label with a line break", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["mark", id, "step 1\nstep 2"]);
    // Then
    expect({ code: result.exitCode, stderr: result.stderr }).toEqual({
      code: 125,
      stderr:
        'Bad Step mark "step 1\nstep 2": use one line of text, for example "step 3: save the post"\n',
    });
  });

  it("record stop refuses a bad --max-size", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--max-size",
      "10KB",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      'Bad --max-size "10KB": use a whole number with MB or GB, for example 800MB\n',
    );
  });

  it("record stop needs --out or --discard", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["record", "stop", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop needs --out <file>, or --discard to make no Proof video\n",
    );
  });

  it("record stop takes --out or --discard, not both", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--discard",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop takes --out <file> or --discard, not both\n",
    );
  });

  effectIt.effect(
    "record stop on a blocked Mac capture names it and downloads the screen",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const mac = blockedMac(root, "the capture stopped");
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        const dir = mkdtempSync(join(tmpdir(), "proofbox-out-"));
        tempRoots.push(dir);
        // When
        const error = yield* Effect.flip(
          stopRecording({ id, out: join(dir, "proof.mp4") }),
        );
        // Then
        const saved = join(dir, "proof-blocked.png");
        expect(error).toBeInstanceOf(CaptureBlockedError);
        expect(error.message).toBe(
          `Recording on ${id} failed: the capture stopped, so no Proof video was made. Saved the screen to ${saved}. Record the walk again.`,
        );
        expect(new Uint8Array(readFileSync(saved))).toEqual(PNG_HEAD);
      }).pipe(Effect.provide(layers(mac)));
    },
  );

  effectIt.effect(
    "at a terminal record stop names a Proof screenshot whose label it cannot read",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const mac = labelLessMac(root);
      const hints: string[] = [];
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        const dir = mkdtempSync(join(tmpdir(), "proofbox-out-"));
        tempRoots.push(dir);
        const out = join(dir, "proof.mp4");
        const shot = join(dir, "proof-1.png");
        // When
        yield* stopRecording({ id, out });
        // Then: the paths print, and the screenshot's line has no label
        const output = yield* CliOutput;
        const stdout = yield* Ref.get(output.captured.out);
        expect({
          stdout: Chunk.toReadonlyArray(stdout).join(""),
          shot: hints.at(-1),
        }).toEqual({
          stdout: `${out}\n${shot}\n`,
          shot: `Proof screenshot ${shot}, Step 1`,
        });
      }).pipe(Effect.provide(layers(mac, { terminal: true, hints })));
    },
  );

  effectIt.effect(
    "record stop --discard on a blocked Mac capture still names it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const mac = blockedMac(root, "the capture stalled");
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        const error = yield* Effect.flip(stopRecording({ id, discard: true }));
        // Then
        expect(error).toBeInstanceOf(CaptureBlockedError);
        expect(
          error.message.startsWith(
            `Recording on ${id} failed: the capture stalled, so no Proof video was made.`,
          ),
        ).toBe(true);
        rmSync(join(process.cwd(), "proof-blocked.png"), { force: true });
      }).pipe(Effect.provide(layers(mac)));
    },
  );

  effectIt.effect(
    "record stop gives the check 2 min plus the Recording's length",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      tempRoots.push(root, runtime);
      const mac = stoppingMac(root, Stream.never);
      return Effect.gen(function* () {
        // Given: a 300 s Recording whose check never answers, on a Sandbox
        // that outlasts the test
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.hours(1),
          maxLife: Duration.hours(2),
        });
        const id = `fake:${info.name}`;
        const dir = mkdtempSync(join(tmpdir(), "proofbox-out-"));
        tempRoots.push(dir);
        // When
        const fiber = yield* Effect.fork(
          Effect.flip(stopRecording({ id, out: join(dir, "proof.mp4") })),
        );
        yield* sleepsNear(420_000);
        yield* TestClock.adjust("421 seconds");
        const error = yield* Fiber.join(fiber);
        // Then
        expect(
          error.message.startsWith(
            `Sandbox ${id} did not answer the record stop in 7 min.`,
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(layers(mac)),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
        ),
      );
    },
  );

  effectIt.effect(
    "record stop accepts a check that takes 400 s on a 5 min Recording",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      tempRoots.push(root, runtime);
      const mac = stoppingMac(
        root,
        Stream.concat(
          Stream.fromEffect(
            Effect.as(Effect.sleep("400 seconds"), {
              _tag: "Stdout" as const,
              bytes: new TextEncoder().encode(
                "Duration: 00:05:00.00\nlavfi.freezedetect.freeze_start: 0\n",
              ),
            }),
          ),
          Stream.make({ _tag: "Exit" as const, code: 0 }),
        ),
      );
      return Effect.gen(function* () {
        // Given: a 300 s Recording whose check answers after 400 s, on a
        // Sandbox that outlasts the test
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.hours(1),
          maxLife: Duration.hours(2),
        });
        const id = `fake:${info.name}`;
        const dir = mkdtempSync(join(tmpdir(), "proofbox-out-"));
        tempRoots.push(dir);
        // When
        const fiber = yield* Effect.fork(
          Effect.flip(stopRecording({ id, out: join(dir, "proof.mp4") })),
        );
        yield* sleepsNear(400_000);
        yield* TestClock.adjust("401 seconds");
        const error = yield* Fiber.join(fiber);
        // Then
        expect(error).toBeInstanceOf(NothingChangedError);
      }).pipe(
        Effect.provide(layers(mac)),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
        ),
      );
    },
  );
});
