import { readFileSync } from "node:fs";
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
