import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Duration, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { Progress } from "../src/progress.ts";

const tempRoots: string[] = [];
const makeRoot = () => {
  const parent = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(parent);
  return join(parent, "root");
};

const noProgress = new Progress({ step: (_label, effect) => effect });

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
      expect(error.reason).toContain("whole number of seconds");
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
            () => fake.extend(sandbox.name, deadline),
            { discard: true },
          ),
          Effect.forEach(
            Array.from({ length: 200 }),
            () => fake.get(sandbox.name),
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
      const collected = yield* fake.connect(sandbox.name).pipe(
        Effect.flatMap((connection) =>
          Stream.runCollect(
            connection.exec(["cat"], {
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
      expect(events[events.length - 1]).toEqual({ _tag: "Exit", code: 0 });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
