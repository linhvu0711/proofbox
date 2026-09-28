import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it.effect("a failed Snapshot copy leaves no Sandbox folder behind", () =>
    Effect.gen(function* () {
      // Given: a Snapshot entry without a home dir, so the copy fails
      const root = makeRoot();
      const snapRoot = makeRoot();
      const fake = makeFakeProvider({
        root,
        watch: "none",
        snapshots: { root: snapRoot },
      });
      mkdirSync(join(snapRoot, "22d0cf15eb8e"), { recursive: true });
      // When
      const error = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        })
        .pipe(Effect.provideService(Progress, noProgress), Effect.flip);
      // Then
      expect(error._tag).toBe("ProviderError");
      expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    }),
  );

  it.effect("two saves of one Fingerprint publish one whole Snapshot", () =>
    Effect.gen(function* () {
      // Given: two Sandboxes saving under the same Fingerprint at once
      const root = makeRoot();
      const snapRoot = makeRoot();
      const fake = makeFakeProvider({
        root,
        watch: "none",
        snapshots: { root: snapRoot },
      });
      const req = {
        os: "linux" as const,
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      };
      const a = yield* fake
        .create(req)
        .pipe(Effect.provideService(Progress, noProgress));
      const b = yield* fake
        .create(req)
        .pipe(Effect.provideService(Progress, noProgress));
      writeFileSync(join(root, a.name, "home", "mark.txt"), "a\n");
      writeFileSync(join(root, b.name, "home", "mark.txt"), "b\n");
      const snapshots = fake.snapshots;
      if (snapshots === undefined) {
        return yield* Effect.die("provider has no snapshots member");
      }
      // When
      yield* Effect.all(
        [snapshots.save(a.name, "fp111"), snapshots.save(b.name, "fp111")],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(Progress, noProgress));
      // Then: one complete Sandbox copy landed, not a mix or a staging dir
      expect(readdirSync(snapRoot)).toEqual(["fp111"]);
      const mark = readFileSync(
        join(snapRoot, "fp111", "home", "mark.txt"),
        "utf8",
      );
      expect(["a\n", "b\n"]).toContainEqual(mark);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
