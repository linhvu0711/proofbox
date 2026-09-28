import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keeperPid = (env: { runtime: string }, name: string) =>
  Number.parseInt(
    readFileSync(join(env.runtime, `fake-${name}.pid`), "utf8").trim(),
    10,
  );

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
});
