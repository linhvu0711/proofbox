import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Duration, Effect, Layer, Ref } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import { idleDefault, nextDeadline, parseSpan } from "../src/deadline.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { HarnessesLive } from "../src/harness-registry.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { nodeFs } from "./support/node-fs.ts";

const tempRoots: string[] = [];
const makeProviders = () => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(root);
  return Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([
      [
        "fake",
        providerEntry(makeFakeProvider({ fs: nodeFs, root, watch: "none" })),
      ],
    ]),
  );
};
const layers = () => {
  // Its own runtime dir and no HOME: create marks itself nowhere real,
  // and takes no logins lock in the developer's HOME.
  const runtime = mkdtempSync(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "proofbox-runtime-",
    ),
  );
  tempRoots.push(runtime);
  const providers = makeProviders();
  return Layer.mergeAll(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
    ),
    NodeContext.layer,
    CliOutput.Test,
    HarnessesLive,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    // A heartbeat-less Progress: the real one leaves a sleeping fiber that
    // races TestClock.adjust and steps the clock in 15-second hops.
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
      }),
    ),
  );
};

const sandboxName = Effect.gen(function* () {
  const output = yield* CliOutput;
  const out = yield* Ref.get(output.captured.out);
  return Chunk.toReadonlyArray(out).join("").trim().replace("fake:", "");
});

const fake = Effect.flatMap(
  Providers,
  (providers) => (providers.get("fake") as ProviderEntry).load,
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
      const info = yield* (yield* fake).get({ name, region: undefined });
      // Then
      expect(info.deadline.toISOString()).toBe("1970-01-01T00:15:00.000Z");
      expect(info.maxLifeAt.toISOString()).toBe("1970-01-01T03:00:00.000Z");
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
