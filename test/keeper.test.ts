import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
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

  it("an exec that exits before its input ends does not break the Keeper", async () => {
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
    const socketPath = join(env.runtime, `fake-${name}.sock`);
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // When: `true` exits at once while the Caller keeps writing input
    socket.write(`${JSON.stringify({ exec: ["true"], stdin: true })}\n`);
    await sleep(500);
    let writeError: Error | undefined;
    socket.on("error", (error) => {
      writeError = error;
    });
    socket.write(
      `${JSON.stringify({ in: Buffer.from("leftover").toString("base64") })}\n`,
      (error) => {
        writeError = error ?? writeError;
      },
    );
    socket.write(`${JSON.stringify({ end: true })}\n`);
    const replies: Array<unknown> = [];
    await new Promise<void>((resolve) => {
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          replies.push(JSON.parse(pending.slice(0, newline)));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    // Then: the input frame landed (no EPIPE), the exit frame came back, and
    // the Keeper still serves
    await sleep(200);
    expect(writeError).toBeUndefined();
    expect(replies).toEqual([{ exit: 0 }]);
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
  });

  it("a client that disconnects mid-exec does not break the Keeper", async () => {
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
    const socketPath = join(env.runtime, `fake-${name}.sock`);
    // When: a client starts a long exec and disappears
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ exec: ["sleep", "5"] })}\n`);
    await sleep(300);
    socket.destroy();
    await sleep(300);
    // Then: the Keeper still serves
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
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
