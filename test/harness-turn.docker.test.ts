import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupEnvs, runCli } from "./support/cli.ts";
import { containers, docker, fixture } from "./support/harness.ts";

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
