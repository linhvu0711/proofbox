import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import {
  createArgs,
  harnessLoginFile,
  loginFile,
  makeGithub,
} from "./support/harness.ts";

describe("delete", () => {
  afterEach(cleanupEnvs);

  it("delete saves back a newer Sandbox login file", async () => {
    const env = makeEnv();
    const { folder, github } = makeGithub();
    loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
    harnessLoginFile(
      env,
      "fake-file",
      `{"last_refresh":"${new Date(Date.now() - 3_600_000).toISOString()}","renewals":0}`,
    );
    const created = await runCli(env, createArgs(folder, "fake-file"), {
      set: { PROOFBOX_GITHUB_URL: `file://${github}` },
    });
    const id = created.stdout.trim();
    const text = '{"last_refresh":"2999-01-01T00:00:00Z","renewals":8}';
    await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'printf %s "$1" > .fake-harness/auth.json',
      "sh",
      text,
    ]);
    const result = await runCli(env, ["delete", id]);
    const saved = readFileSync(
      join(
        env.env.HOME ?? "",
        ".config",
        "proofbox",
        "harness-logins",
        "fake-file",
        "auth.json",
      ),
      "utf8",
    );
    expect({ code: result.exitCode, stdout: result.stdout, saved }).toEqual({
      code: 0,
      stdout: `Deleted ${id}\n`,
      saved: text,
    });
  });

  it("delete removes the Sandbox folder", async () => {
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
    const result = await runCli(env, ["delete", id]);
    // Then
    expect(result.stdout).toBe(`Deleted ${id}\n`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(env.root, id.slice("fake:".length)))).toBe(false);
  });

  it("delete removes an Unfinished Sandbox", async () => {
    // Given: a Sandbox folder a create started and never finished
    const env = makeEnv();
    mkdirSync(join(env.root, "uuuuuu"));
    // When
    const result = await runCli(env, ["delete", "fake:uuuuuu"]);
    // Then
    expect({
      stdout: result.stdout,
      left: existsSync(join(env.root, "uuuuuu")),
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "Deleted fake:uuuuuu\n",
      left: false,
      exitCode: 0,
    });
  });

  it("delete of a missing Sandbox is a quiet no-op", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["delete", "fake:qqqqqq"]);
    // Then
    expect(result.stdout).toBe("Sandbox fake:qqqqqq is already gone\n");
    expect(result.exitCode).toBe(0);
  });

  it("a second delete says already gone and exits 0", async () => {
    // Given: a created id, deleted once
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    await runCli(env, ["delete", id]);
    // When
    const result = await runCli(env, ["delete", id]);
    // Then
    expect(result.stdout).toBe(`Sandbox ${id} is already gone\n`);
    expect(result.exitCode).toBe(0);
  });

  it("exec after delete says the Sandbox is gone", async () => {
    // Given: a created id, then deleted
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    await runCli(env, ["delete", id]);
    // When
    const result = await runCli(env, ["exec", id, "--", "true"]);
    // Then
    expect(result.stderr).toBe(`Sandbox ${id} is gone\n`);
    expect(result.exitCode).toBe(125);
  });
});
