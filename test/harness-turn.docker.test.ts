import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupEnvs, runCli } from "./support/cli.ts";
import {
  containers,
  docker,
  fakeCodexLogin,
  fixture,
} from "./support/harness.ts";

afterEach(() => {
  for (const container of containers.splice(0)) docker("rm", "-f", container);
  cleanupEnvs();
});

it("a Turn on Docker outlives the Keeper while upload, exec, and screenshot work", async () => {
  // Given
  const { env, folder, settings, create } = fixture("fake");
  const created = await create();
  const id = created.stdout.trim();
  const prompt = await runCli(
    env,
    ["harness", "prompt", id, "sleep 30"],
    settings,
  );
  if (prompt.exitCode !== 0) throw new Error(prompt.stderr);
  const pid = Number(
    readFileSync(join(env.runtime, `docker-${id.slice(7)}.pid`), "utf8").trim(),
  );
  process.kill(pid, "SIGKILL");
  // When
  const upload = await runCli(env, ["upload", id, folder], settings);
  const exec = await runCli(
    env,
    ["exec", id, "--", "echo", "during-turn"],
    settings,
  );
  const path = join(env.root, "turn.png");
  const shot = await runCli(env, ["screenshot", id, "--out", path], settings);
  const wait = await runCli(env, ["harness", "wait", id], settings);
  // Then
  expect({
    upload: upload.exitCode,
    exec: exec.stdout,
    shot: shot.exitCode,
    png: existsSync(path),
    wait: wait.stdout,
    code: wait.exitCode,
  }).toEqual({
    upload: 0,
    exec: "during-turn\n",
    shot: 0,
    png: true,
    wait: "done\nslept 30s\n",
    code: 0,
  });
}, 300_000);

it("a refused Codex login ends the Turn with exit 21 and the login fix", async () => {
  // Given
  const { env, settings, create } = fixture("codex", {
    file: fakeCodexLogin(),
  });
  const created = await create();
  const id = created.stdout.trim();
  // When
  await runCli(env, ["harness", "prompt", id, "say hi"], settings);
  const result = await runCli(env, ["harness", "wait", id], settings);
  // Then
  expect({
    code: result.exitCode,
    refused: result.stdout.startsWith("failed: Harness login refused: "),
    fix: result.stdout.endsWith(
      "fix: run proofbox harness login codex, then make a new Sandbox with proofbox create --harness codex\n",
    ),
  }).toEqual({ code: 21, refused: true, fix: true });
}, 300_000);

it("a second Codex prompt resumes the first Turn's session", async () => {
  // Given
  const { env, settings, create, exec } = fixture("codex", {
    file: fakeCodexLogin(),
  });
  const created = await create();
  const id = created.stdout.trim();
  await runCli(env, ["harness", "prompt", id, "say hi"], settings);
  await runCli(env, ["harness", "wait", id], settings);
  const first = await exec(id, "cat", "/var/lib/proofbox/harness-session");
  // When
  await runCli(env, ["harness", "prompt", id, "say hi again"], settings);
  const result = await runCli(env, ["harness", "wait", id], settings);
  const start = await exec(id, "head", "-n", "1", "/var/lib/proofbox/turn/out");
  // Then
  expect({
    code: result.exitCode,
    same:
      start.stdout.trim() ===
      `{"type":"thread.started","thread_id":"${first.stdout.trim()}"}`,
  }).toEqual({ code: 21, same: true });
}, 300_000);

it("harness stop ends a running Codex Turn", async () => {
  // Given
  const { env, settings, create } = fixture("codex", {
    file: fakeCodexLogin(),
  });
  const created = await create();
  const id = created.stdout.trim();
  await runCli(env, ["harness", "prompt", id, "say hi"], settings);
  // When
  const stop = await runCli(env, ["harness", "stop", id], settings);
  const result = await runCli(env, ["harness", "wait", id], settings);
  // Then
  expect({
    stop: stop.stderr,
    code: result.exitCode,
    stdout: result.stdout,
  }).toEqual({
    stop: "proofbox: stopped the turn\n",
    code: 20,
    stdout: "stopped\n",
  });
}, 300_000);
