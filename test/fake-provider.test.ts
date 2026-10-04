import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Duration, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import { runCommand } from "../src/command-checks.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { Progress } from "../src/progress.ts";

const tempRoots: string[] = [];
const makeRoot = () => {
  const parent = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(parent);
  return join(parent, "root");
};

const noProgress = new Progress({
  step: (_label, effect) => effect,
  warn: () => Effect.void,
});

describe("fake Provider", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("create refuses an idle time that is not whole seconds", () =>
    Effect.gen(function* () {
      // Given
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      // When
      const error = yield* fake
        .create({
          os: "linux",
          idle: Duration.millis(1500),
          maxLife: Duration.hours(1),
        })
        .pipe(Effect.provideService(Progress, noProgress), Effect.flip);
      // Then: a ProviderError, and no Sandbox folder was made
      expect(error._tag).toBe("ProviderError");
      if (error._tag === "ProviderError") {
        expect(error.reason).toContain("whole number of seconds");
      }
      expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    }),
  );

  it.effect("get reads a whole Sandbox while an extend rewrites it", () =>
    Effect.gen(function* () {
      // Given: a fake Sandbox
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      const sandbox = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      // When: many extends and gets run at the same time
      const deadline = new Date(Duration.toMillis(Duration.minutes(20)));
      yield* Effect.all(
        [
          Effect.forEach(
            Array.from({ length: 200 }),
            () =>
              fake.extend({ name: sandbox.name, region: undefined }, deadline),
            { discard: true },
          ),
          Effect.forEach(
            Array.from({ length: 200 }),
            () => fake.get({ name: sandbox.name, region: undefined }),
            { discard: true },
          ),
        ],
        { concurrency: "unbounded" },
      );
      // Then: no get failed, and no temp file is left behind
      expect(readdirSync(join(root, sandbox.name))).not.toContainEqual(
        expect.stringMatching(/\.tmp$/),
      );
    }),
  );

  it.effect("extend writes the Deadline that get reads, in whole seconds", () =>
    Effect.gen(function* () {
      // Given: a fake Sandbox
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      const sandbox = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const ref = { name: sandbox.name, region: undefined };
      // When
      yield* fake.extend(ref, new Date(1_200_500));
      const info = yield* fake.get(ref);
      const file = readFileSync(join(root, sandbox.name, "deadline"), "utf8");
      // Then
      expect({ deadline: info.deadline.toISOString(), file }).toEqual({
        deadline: "1970-01-01T00:20:00.000Z",
        file: "1200\n",
      });
    }),
  );

  it.effect("fake exec feeds stdin to the command", () =>
    Effect.gen(function* () {
      // Given: a fake Sandbox
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      const sandbox = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      // When: `cat` runs with a stdin stream
      const collected = yield* fake
        .connect({ name: sandbox.name, region: undefined })
        .pipe(
          Effect.flatMap((connection) =>
            Stream.runCollect(
              runCommand(connection, ["cat"], {
                stdin: Stream.make(new TextEncoder().encode("hi\n")),
              }),
            ),
          ),
          Effect.scoped,
        );
      // Then: the bytes come back on stdout and the exit is clean
      const events = Chunk.toReadonlyArray(collected);
      const decoder = new TextDecoder();
      const stdout = events
        .filter((event) => event._tag === "Stdout")
        .map((event) => decoder.decode(event.bytes))
        .join("");
      expect(stdout).toBe("hi\n");
      expect(events.some((event) => event._tag === "Stderr")).toBe(false);
      expect(events[events.length - 1]).toEqual({
        _tag: "Exit",
        code: 0,
        kills: { before: 0, after: 0 },
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("a command on the fake pushes the Deadline that get reads", () =>
    Effect.gen(function* () {
      // Given: a fake Sandbox whose Deadline is one minute away
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      const sandbox = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const ref = { name: sandbox.name, region: undefined };
      yield* fake.extend(ref, new Date(Date.now() + 60_000));
      // When
      const before = Math.floor(Date.now() / 1000);
      yield* fake.connect(ref).pipe(
        Effect.flatMap((connection) =>
          Stream.runDrain(runCommand(connection, ["true"])),
        ),
        Effect.scoped,
      );
      const after = Math.floor(Date.now() / 1000);
      const info = yield* fake.get(ref);
      // Then: the Deadline is the idle time from when the command ran
      const seconds = info.deadline.getTime() / 1000;
      expect(
        seconds >= before + 900 && seconds <= after + 900
          ? "pushed"
          : `Deadline ${seconds} not in ${before + 900}..${after + 900}`,
      ).toBe("pushed");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("fake exec gives a command with no stdin end of input at once", () =>
    Effect.gen(function* () {
      // Given: a fake Sandbox
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      const sandbox = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      // When: a command that reads stdin runs with no stdin given
      const collected = yield* fake
        .connect({ name: sandbox.name, region: undefined })
        .pipe(
          Effect.flatMap((connection) =>
            Stream.runCollect(
              runCommand(connection, ["sh", "-c", 'read x; echo "rc:$?"']),
            ),
          ),
          Effect.scoped,
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () => "no end of input within 5 s",
          }),
        );
      // Then: `read` sees end of input at once and the exit is clean
      const events = Chunk.toReadonlyArray(collected);
      const decoder = new TextDecoder();
      const stdout = events
        .filter((event) => event._tag === "Stdout")
        .map((event) => decoder.decode(event.bytes))
        .join("");
      expect({ stdout, last: events[events.length - 1] }).toEqual({
        stdout: "rc:1\n",
        last: { _tag: "Exit", code: 0, kills: { before: 0, after: 0 } },
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect(
    "fake exec fails with a ProviderError when the command cannot start",
    () =>
      Effect.gen(function* () {
        // Given: a fake Sandbox whose home folder is gone
        const root = makeRoot();
        const fake = makeFakeProvider({ root, watch: "none" });
        const sandbox = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        rmSync(join(root, sandbox.name, "home"), {
          recursive: true,
          force: true,
        });
        // When
        const error = yield* fake
          .connect({ name: sandbox.name, region: undefined })
          .pipe(
            Effect.flatMap((connection) =>
              Stream.runDrain(runCommand(connection, ["true"])),
            ),
            Effect.scoped,
            Effect.flip,
          );
        // Then: a ProviderError from the fake, naming the missing folder
        expect(error._tag).toBe("ProviderError");
        if (error._tag === "ProviderError") {
          expect(error.provider).toBe("fake");
          expect(error.reason).toContain("NotFound");
        }
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});
