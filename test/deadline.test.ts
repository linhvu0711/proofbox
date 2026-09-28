import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Layer,
  Ref,
  TestClock,
  TestServices,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import { idleDefault, nextDeadline, parseSpan } from "../src/deadline.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import { type Provider, Providers } from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const tempRoots: string[] = [];
const makeProviders = () => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(root);
  return Layer.succeed(
    Providers,
    new Map<string, Provider>([
      ["fake", makeFakeProvider({ root, watch: "none" })],
    ]),
  );
};
const layers = () => {
  const providers = makeProviders();
  return Layer.mergeAll(
    NodeContext.layer,
    CliOutput.Test,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    // A heartbeat-less Progress: the real one leaves a sleeping fiber that
    // races TestClock.adjust and steps the clock in 15-second hops.
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
      }),
    ),
  );
};

const sandboxName = Effect.gen(function* () {
  const output = yield* CliOutput;
  const out = yield* Ref.get(output.captured.out);
  return Chunk.toReadonlyArray(out).join("").trim().replace("fake:", "");
});

const fake = Effect.map(
  Providers,
  (providers) => providers.get("fake") as Provider,
);

describe("Deadline", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    cleanupEnvs();
  });

  it("nextDeadline adds the idle time", () => {
    // Given: now, idle 15 minutes, max life at 13:00
    const deadline = nextDeadline({
      now: new Date("2026-09-28T10:00:00.000Z"),
      idle: Duration.minutes(15),
      maxLifeAt: new Date("2026-09-28T13:00:00.000Z"),
    });
    // Then
    expect(deadline.toISOString()).toBe("2026-09-28T10:15:00.000Z");
  });

  it("nextDeadline never passes the Max life", () => {
    // Given: now + idle lands after max life
    const deadline = nextDeadline({
      now: new Date("2026-09-28T12:50:00.000Z"),
      idle: Duration.minutes(15),
      maxLifeAt: new Date("2026-09-28T13:00:00.000Z"),
    });
    // Then
    expect(deadline.toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });

  it("idle defaults to 5 min on macOS and 15 min on Linux", () => {
    // When
    const macos = Duration.toMinutes(idleDefault("macos"));
    const linux = Duration.toMinutes(idleDefault("linux"));
    // Then
    expect(macos).toBe(5);
    expect(linux).toBe(15);
  });

  it.effect("parseSpan reads s, m, and h", () =>
    Effect.gen(function* () {
      // When / Then
      expect(Duration.toSeconds(yield* parseSpan("idle", "90s"))).toBe(90);
      expect(Duration.toSeconds(yield* parseSpan("idle", "15m"))).toBe(900);
      expect(Duration.toSeconds(yield* parseSpan("max-life", "3h"))).toBe(
        10800,
      );
    }),
  );

  it.effect("create uses the Linux defaults", () =>
    Effect.gen(function* () {
      // Given: a fake provider rooted in a temp dir
      // When
      yield* createSandbox({ os: "linux", provider: "fake" });
      const name = yield* sandboxName;
      const info = yield* (yield* fake).get(name);
      // Then
      expect(info.deadline.toISOString()).toBe("1970-01-01T00:15:00.000Z");
      expect(info.maxLifeAt.toISOString()).toBe("1970-01-01T03:00:00.000Z");
    }).pipe(Effect.provide(layers())),
  );

  it.effect("exec pushes the Deadline by the idle time", () =>
    Effect.gen(function* () {
      // Given: a Sandbox at t=0
      yield* createSandbox({ os: "linux", provider: "fake" });
      const name = yield* sandboxName;
      yield* TestClock.adjust("10 minutes");
      // When
      yield* execInSandbox(`fake:${name}`, ["true"]);
      const info = yield* (yield* fake).get(name);
      // Then
      expect(info.deadline.toISOString()).toBe("1970-01-01T00:25:00.000Z");
    }).pipe(Effect.provide(layers())),
  );

  it.effect("exec never pushes past --max-life", () =>
    Effect.gen(function* () {
      // Given: a Sandbox with a 20 minute max life
      yield* createSandbox({
        os: "linux",
        provider: "fake",
        idle: "15m",
        maxLife: "20m",
      });
      const name = yield* sandboxName;
      yield* TestClock.adjust("10 minutes");
      // When
      yield* execInSandbox(`fake:${name}`, ["true"]);
      const info = yield* (yield* fake).get(name);
      // Then
      expect(info.deadline.toISOString()).toBe("1970-01-01T00:20:00.000Z");
    }).pipe(Effect.provide(layers())),
  );

  it.effect("a long exec keeps pushing the Deadline", () =>
    Effect.gen(function* () {
      const waitForDeadline = (name: string, expected: string) =>
        Effect.gen(function* () {
          for (let i = 0; i < 100; i++) {
            const info = yield* (yield* fake).get(name);
            if (info.deadline.toISOString() === expected) {
              return;
            }
            // Live sleep only: wrapping get would give the provider the real
            // clock and it would see the virtual deadline as passed.
            yield* TestServices.provideLive(Effect.sleep("20 millis"));
          }
          const last = yield* (yield* fake).get(name);
          return yield* Effect.fail(
            new Error(
              `deadline not pushed yet; at ${last.deadline.toISOString()}`,
            ),
          );
        });
      // Given: a Sandbox and an exec that only ends when the test allows
      yield* createSandbox({ os: "linux", provider: "fake" });
      const name = yield* sandboxName;
      const fiber = yield* Effect.fork(
        execInSandbox(`fake:${name}`, [
          "sh",
          "-c",
          "while [ ! -f go ]; do sleep 0.05; done",
        ]),
      );
      // When: each spaced push fires at 5-minute marks of the 15-minute idle
      yield* TestServices.provideLive(Effect.sleep("500 millis"));
      yield* TestClock.adjust("5 minutes");
      yield* waitForDeadline(name, "1970-01-01T00:20:00.000Z");
      yield* TestClock.adjust("5 minutes");
      yield* waitForDeadline(name, "1970-01-01T00:25:00.000Z");
      const running = yield* (yield* fake).get(name);
      yield* TestClock.adjust("2 minutes");
      yield* Effect.sync(() =>
        writeFileSync(
          join(tempRoots[tempRoots.length - 1] as string, name, "home", "go"),
          "",
        ),
      );
      yield* Fiber.join(fiber);
      const done = yield* (yield* fake).get(name);
      // Then
      expect(running.deadline.toISOString()).toBe("1970-01-01T00:25:00.000Z");
      expect(done.deadline.toISOString()).toBe("1970-01-01T00:27:00.000Z");
    }).pipe(Effect.provide(layers())),
  );

  it("a bad --idle is refused", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--idle",
      "abc",
    ]);
    // Then
    expect(result.stderr).toBe(
      'Bad --idle "abc": use a whole number with s, m, or h, for example 15m\n',
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });
});
