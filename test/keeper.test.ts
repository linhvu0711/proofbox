import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Duration, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { runKeeper } from "../src/keeper/keeper.ts";
import { Progress } from "../src/progress.ts";
import { Providers } from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keeperPid = (env: { runtime: string }, name: string) =>
  Number.parseInt(
    readFileSync(join(env.runtime, `fake-${name}.pid`), "utf8").trim(),
    10,
  );

const noProgress = new Progress({ step: (_label, effect) => effect });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Keeper", () => {
  afterEach(cleanupEnvs);

  it("create starts a Keeper", async () => {
    // Given
    const env = makeEnv();
    // When
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    // Then
    const pidFile = join(env.runtime, `fake-${name}.pid`);
    expect(existsSync(pidFile)).toBe(true);
    expect(alive(keeperPid(env, name))).toBe(true);
  });

  it("exec starts a new Keeper after the old one is killed", async () => {
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
    const name = id.slice("fake:".length);
    const oldPid = keeperPid(env, name);
    process.kill(oldPid, "SIGKILL");
    for (let i = 0; i < 50 && alive(oldPid); i++) {
      await sleep(100);
    }
    // When
    const result = await runCli(env, ["exec", id, "--", "echo", "back"]);
    // Then
    expect(result.stdout).toBe("back\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const newPid = keeperPid(env, name);
    expect(newPid).not.toBe(oldPid);
    expect(alive(newPid)).toBe(true);
  });

  it("delete stops the Keeper", async () => {
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
    const name = id.slice("fake:".length);
    const pid = keeperPid(env, name);
    // When
    await runCli(env, ["delete", id]);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(100);
      gone = !alive(pid);
    }
    // Then
    expect(gone).toBe(true);
    expect(existsSync(join(env.runtime, `fake-${name}.sock`))).toBe(false);
    expect(existsSync(join(env.runtime, `fake-${name}.pid`))).toBe(false);
  });

  it("the Keeper stops when its Deadline passes", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--idle",
      "2s",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    const pid = keeperPid(env, name);
    // When
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(200);
      gone = !alive(pid);
    }
    // Then
    expect(gone).toBe(true);
  });

  it.effect(
    "the Keeper fails with ProviderError when it cannot write its pid file",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox, and a folder where the Keeper's pid file goes
        const env = makeEnv();
        const fake = makeFakeProvider({ root: env.root, watch: "none" });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        mkdirSync(join(env.runtime, `fake-${info.name}.pid`));
        // When
        const error = yield* runKeeper(`fake:${info.name}`).pipe(
          Effect.provideService(Providers, new Map([["fake", fake]])),
          Effect.provide(NodeContext.layer),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(
              new Map([["PROOFBOX_RUNTIME_DIR", env.runtime]]),
            ),
          ),
          Effect.flip,
        );
        // Then
        expect(error).toMatchObject({
          _tag: "ProviderError",
          provider: "fake",
          reason: expect.stringContaining("EISDIR"),
        });
      }),
  );
});
