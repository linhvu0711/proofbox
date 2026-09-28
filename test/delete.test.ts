import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("delete", () => {
  afterEach(cleanupEnvs);

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
