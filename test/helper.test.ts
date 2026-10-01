import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
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
  TestServices,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { clickAt } from "../src/commands/click.ts";
import { dragFrom } from "../src/commands/drag.ts";
import { pressKey } from "../src/commands/key.ts";
import { setMark } from "../src/commands/mark.ts";
import { startRecording, stopRecording } from "../src/commands/record.ts";
import { takeScreenshot } from "../src/commands/screenshot.ts";
import { scrollAt } from "../src/commands/scroll.ts";
import { typeText } from "../src/commands/type.ts";
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

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const tempRoots: string[] = [];

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
};

type Answer = (argv: ReadonlyArray<string>) => Stream.Stream<ExecEvent>;

// A fake Sandbox that reports itself as a Mac with a desktop, whose exec
// gives each helper call the answer `answer` returns, and counts the calls.
const stubMac = (root: string, answer: Answer) => {
  const base = makeFakeProvider({ root, watch: "none" });
  const calls = { exec: 0 };
  const mac: Provider = {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) => ({
        ...connection,
        exec: (argv) =>
          Stream.suspend(() => {
            calls.exec += 1;
            return answer(argv);
          }),
      })),
  };
  return { mac, calls };
};

const noProgress = new Progress({
  step: (_label, effect) => effect,
  warn: () => Effect.void,
});

const layers = (mac: Provider) => {
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([["fake", providerEntry(mac)]]),
  );
  return Layer.mergeAll(
    NodeContext.layer,
    CliOutput.Test,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    Layer.succeed(Progress, noProgress),
  );
};

// A stub Mac made at t=0, the runtime folder its Keeper log goes in, and
// the layers and config a command needs to reach it.
const macSandbox = (answer: Answer) =>
  Effect.gen(function* () {
    const root = tempDir("proofbox-fake-");
    const runtime = tempDir("proofbox-runtime-");
    const { mac, calls } = stubMac(root, answer);
    const info = yield* mac
      .create({
        os: "macos",
        idle: Duration.minutes(5),
        maxLife: Duration.hours(1),
      })
      .pipe(Effect.provideService(Progress, noProgress));
    return {
      id: `fake:${info.name}`,
      log: join(runtime, `fake-${info.name}.log`),
      calls,
      provide: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | CliOutput
          | Providers
          | KeeperClient
          | Progress
          | NodeContext.NodeContext
        >,
      ) =>
        effect.pipe(
          Effect.provide(layers(mac)),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(
              new Map([["PROOFBOX_RUNTIME_DIR", runtime]]),
            ),
          ),
        ),
    };
  });

// Waits, on the real clock, until the TestClock holds a sleep that ends at
// or after each of `ends` (ms since t=0), so a call's own timers are set
// before a test moves the clock. A retry sets its timer at 120 s or a
// little later, as its file reads finish before or after the clock stops.
const sleepsFrom = (...ends: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const pending = Chunk.toReadonlyArray(yield* TestClock.sleeps());
      if (ends.every((end) => pending.some((at) => at >= end))) {
        return;
      }
      yield* TestServices.provideLive(Effect.sleep("10 millis"));
    }
  });

const captured = (which: "out" | "err") =>
  Effect.gen(function* () {
    const output = yield* CliOutput;
    return Chunk.toReadonlyArray(yield* Ref.get(output.captured[which])).join(
      "",
    );
  });

const stdout = (bytes: Uint8Array): ExecEvent => ({ _tag: "Stdout", bytes });
const exit = (code: number): ExecEvent => ({ _tag: "Exit", code });

// The first bytes of a PNG, then nothing more, ever: the Mac's stall.
const stalled: Answer = () =>
  Stream.concat(Stream.make(stdout(PNG_HEAD)), Stream.never);

describe("Helper call time limits", () => {
  // A Deadline push already writing when its call ended can still land a
  // file in the fake root; the retries let that write finish first.
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it.effect("a stalled screenshot fails after 2 min, twice", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = yield* macSandbox(stalled);
      const out = join(tempDir("proofbox-out-"), "s.png");
      // When
      const error = yield* sandbox.provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.flip(takeScreenshot(sandbox.id, out)),
          );
          yield* sleepsFrom(120_000);
          yield* TestClock.adjust("121 seconds");
          yield* sleepsFrom(240_000);
          yield* TestClock.adjust("130 seconds");
          return yield* Fiber.join(fiber);
        }),
      );
      // Then
      expect(error.message).toBe(
        `Sandbox ${sandbox.id} did not answer the screenshot in 2 min, twice. Try again in a minute. Keeper log: ${sandbox.log}`,
      );
    }),
  );

  it.effect("a stalled screenshot writes no PNG", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = yield* macSandbox(stalled);
      const out = join(tempDir("proofbox-out-"), "s.png");
      // When
      yield* sandbox.provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.flip(takeScreenshot(sandbox.id, out)),
          );
          yield* sleepsFrom(120_000);
          yield* TestClock.adjust("121 seconds");
          yield* sleepsFrom(240_000);
          yield* TestClock.adjust("130 seconds");
          return yield* Fiber.join(fiber);
        }),
      );
      // Then
      expect(existsSync(out)).toBe(false);
    }),
  );

  it.effect(
    "a stalled screenshot prints the retry line before its second try",
    () =>
      Effect.gen(function* () {
        // Given
        const sandbox = yield* macSandbox(stalled);
        const out = join(tempDir("proofbox-out-"), "s.png");
        // When
        const printed = yield* sandbox.provide(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(takeScreenshot(sandbox.id, out));
            yield* sleepsFrom(120_000);
            yield* TestClock.adjust("121 seconds");
            yield* sleepsFrom(240_000);
            const printed = {
              err: yield* captured("err"),
              out: yield* captured("out"),
            };
            yield* Fiber.interrupt(fiber);
            return printed;
          }),
        );
        // Then
        expect(printed).toEqual({
          err: "proofbox: the screenshot did not answer in 2 min; trying once more\n",
          out: "",
        });
      }),
  );

  it.effect(
    "a Mac screenshot that takes 43 s succeeds with no retry line",
    () =>
      Effect.gen(function* () {
        // Given: the answer comes whole after 43 s
        const sandbox = yield* macSandbox(() =>
          Stream.concat(
            Stream.fromEffect(
              Effect.as(Effect.sleep("43 seconds"), stdout(PNG_HEAD)),
            ),
            Stream.make(exit(0)),
          ),
        );
        const out = join(tempDir("proofbox-out-"), "s.png");
        // When
        const err = yield* sandbox.provide(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(takeScreenshot(sandbox.id, out));
            yield* sleepsFrom(43_000, 120_000);
            yield* TestClock.adjust("44 seconds");
            yield* Fiber.join(fiber);
            return yield* captured("err");
          }),
        );
        // Then
        expect({ err, png: new Uint8Array(readFileSync(out)) }).toEqual({
          err: "",
          png: PNG_HEAD,
        });
      }),
  );

  type Needs =
    | CliOutput
    | Providers
    | KeeperClient
    | Progress
    | NodeContext.NodeContext;
  interface Action {
    readonly name: string;
    readonly run: (
      id: string,
    ) => Effect.Effect<unknown, { readonly message: string }, Needs>;
  }

  const actions: ReadonlyArray<Action> = [
    {
      name: "click",
      run: (id: string) =>
        clickAt({ id, x: 1, y: 1, button: "left", pace: "fast" }),
    },
    {
      name: "type",
      run: (id: string) =>
        typeText({ id, text: "a", pace: "fast", letter: "0ms" }),
    },
    {
      name: "key",
      run: (id: string) => pressKey({ id, keys: "Return", pace: "fast" }),
    },
    {
      name: "scroll",
      run: (id: string) =>
        scrollAt({
          id,
          x: 1,
          y: 1,
          direction: "down",
          steps: 1,
          pace: "fast",
        }),
    },
    {
      name: "drag",
      run: (id: string) =>
        dragFrom({ id, x1: 1, y1: 1, x2: 2, y2: 2, pace: "fast" }),
    },
    { name: "mark", run: (id: string) => setMark({ id, label: "step" }) },
    { name: "record start", run: (id: string) => startRecording(id) },
    {
      name: "record stop",
      run: (id: string) => stopRecording({ id, discard: true }),
    },
  ];

  it.effect.each(actions)(
    "a stalled action fails once and names itself: $name",
    ({ name, run }) =>
      Effect.gen(function* () {
        // Given: every helper call stalls
        const sandbox = yield* macSandbox(() => Stream.never);
        // When
        const error = yield* sandbox.provide(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(Effect.flip(run(sandbox.id)));
            yield* sleepsFrom(120_000);
            yield* TestClock.adjust("121 seconds");
            yield* TestClock.adjust("200 seconds");
            return yield* Fiber.join(fiber);
          }),
        );
        // Then
        expect({ message: error.message, calls: sandbox.calls.exec }).toEqual({
          message: `Sandbox ${sandbox.id} did not answer the ${name} in 2 min. The ${name} may have happened; take a screenshot to check before you try again. Keeper log: ${sandbox.log}`,
          calls: 1,
        });
      }),
  );

  it.effect("a click gets 2 min plus its glide and settle", () =>
    Effect.gen(function* () {
      // Given: human pace, glide 400 ms and settle 700 ms
      const sandbox = yield* macSandbox(() => Stream.never);
      // When
      const error = yield* sandbox.provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.flip(
              clickAt({
                id: sandbox.id,
                x: 1,
                y: 1,
                button: "left",
                pace: "human",
              }),
            ),
          );
          yield* sleepsFrom(120_000);
          yield* TestClock.adjust("122 seconds");
          return yield* Fiber.join(fiber);
        }),
      );
      // Then
      expect(error.message).toMatch(
        new RegExp(
          `^Sandbox ${sandbox.id} did not answer the click in 2 min 1 s\\.`,
        ),
      );
    }),
  );

  it.effect("a type that runs 150 s still succeeds", () =>
    Effect.gen(function* () {
      // Given: six letters at 25 s each
      const sandbox = yield* macSandbox(() =>
        Stream.fromEffect(Effect.as(Effect.sleep("150 seconds"), exit(0))),
      );
      // When
      const err = yield* sandbox.provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            typeText({
              id: sandbox.id,
              text: "abcdef",
              pace: "fast",
              letter: "25s",
              typeMax: "200s",
            }),
          );
          yield* sleepsFrom(150_000);
          yield* TestClock.adjust("151 seconds");
          yield* Fiber.join(fiber);
          return yield* captured("err");
        }),
      );
      // Then
      expect(err).toBe("");
    }),
  );
});
