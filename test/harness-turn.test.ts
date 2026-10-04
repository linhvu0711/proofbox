import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { createArgs, fakeLogins, makeGithub } from "./support/harness.ts";

afterEach(cleanupEnvs);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sandbox = async (env: CliEnv, extra: string[] = []) => {
  const { folder, github } = makeGithub();
  fakeLogins(env);
  const created = await runCli(env, [...createArgs(folder, "fake"), ...extra], {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  if (created.exitCode !== 0) throw new Error(created.stderr);
  return created.stdout.trim();
};

it("harness wait prints done and the last message", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "make hello.txt"]);
  // When
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect(result).toEqual({
    exitCode: 0,
    stdout: "done\ndid: make hello.txt\n",
    stderr: "",
  });
});

it("harness prompt prints that the Turn started", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  // When
  const result = await runCli(env, ["harness", "prompt", id, "make hello.txt"]);
  // Then
  expect(result).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: `proofbox: turn started; run proofbox harness wait ${id}\n`,
  });
});

it("a second prompt resumes the Harness session", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "make hello.txt"]);
  await runCli(env, ["harness", "wait", id]);
  // When
  await runCli(env, ["harness", "prompt", id, "recall"]);
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect({ code: result.exitCode, stdout: result.stdout }).toEqual({
    code: 0,
    stdout: "done\nremembers: make hello.txt\n",
  });
});

it("two harness waits on one ended Turn print the same result", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "make hello.txt"]);
  // When
  const first = await runCli(env, ["harness", "wait", id]);
  const second = await runCli(env, ["harness", "wait", id]);
  // Then
  expect(
    [first, second].map((result) => ({
      code: result.exitCode,
      stdout: result.stdout,
    })),
  ).toEqual([
    { code: 0, stdout: "done\ndid: make hello.txt\n" },
    { code: 0, stdout: "done\ndid: make hello.txt\n" },
  ]);
});

it("an empty prompt is refused before the Sandbox is read", async () => {
  // Given
  const env = makeEnv();
  // When
  const result = await runCli(env, ["harness", "prompt", "fake:nope00", "   "]);
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr: "The prompt is empty; nothing was started.\n",
  });
});

it("harness prompt on a Sandbox made without --harness is refused", async () => {
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
  const result = await runCli(env, ["harness", "prompt", id, "hi"]);
  // Then
  expect(result.exitCode).toBe(125);
  expect(result.stderr).toBe(
    `Sandbox ${id} was made without --harness; make one with proofbox create --harness claude.\n`,
  );
  expect(existsSync(join(env.root, id.slice(5), "state", "turn"))).toBe(false);
});

it("harness wait before any prompt says no turn has run yet", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  // When
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr: `no turn has run yet; run proofbox harness prompt ${id} "<prompt>"\n`,
  });
});

it("a prompt while a Turn runs is refused", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "sleep 20"]);
  // When
  const result = await runCli(env, ["harness", "prompt", id, "hi"]);
  // Then
  expect(result.exitCode).toBe(125);
  expect(result.stderr).toBe(
    "a turn is running; run proofbox harness wait or proofbox harness stop\n",
  );
});

it("a refused Harness login prints the fix and exits 21", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "fail login"]);
  // When
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect({ code: result.exitCode, stdout: result.stdout }).toEqual({
    code: 21,
    stdout:
      "failed: Harness login refused: 401 login refused\nfix: run proofbox harness login fake\n",
  });
});

it("a usage limit prints the reset time and exits 22", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "fail usage-limit"]);
  // When
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect({ code: result.exitCode, stdout: result.stdout }).toEqual({
    code: 22,
    stdout:
      "failed: usage limit: usage limit reached\nresets: 2026-10-05T03:00:00Z\nfix: wait for the reset, then send the next prompt\n",
  });
});

it("a Harness crash prints its last lines and exits 23", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env);
  await runCli(env, ["harness", "prompt", id, "crash"]);
  // When
  const result = await runCli(env, ["harness", "wait", id]);
  // Then
  expect({ code: result.exitCode, stdout: result.stdout }).toEqual({
    code: 23,
    stdout:
      "failed: Harness crashed with exit code 3\nfake-harness: crashed on purpose\nfix: read the lines above, then send the next prompt\n",
  });
});

it("harness wait moves the Deadline while it runs and not after it is killed", async () => {
  // Given
  const env = makeEnv();
  const id = await sandbox(env, ["--idle", "1m"]);
  await runCli(env, ["harness", "prompt", id, "sleep 40"]);
  const deadline = () =>
    Number(readFileSync(join(env.root, id.slice(5), "deadline"), "utf8"));
  let stopWait = () => {};
  const waiting = runCli(env, ["harness", "wait", id], {
    onSpawn: (interrupt) => {
      stopWait = interrupt;
    },
  });
  // When
  await sleep(2000);
  const d0 = deadline();
  await sleep(8000);
  const d1 = deadline();
  stopWait();
  await waiting;
  await sleep(1000);
  const d2 = deadline();
  await sleep(8000);
  const d3 = deadline();
  // Then
  expect({ moved: d1 > d0, still: d3 === d2 }).toEqual({
    moved: true,
    still: true,
  });
});
