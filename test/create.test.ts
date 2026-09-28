import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("create", () => {
  afterEach(cleanupEnvs);

  it("create prints a fake Sandbox id", async () => {
    // Given: fresh fake root and runtime dirs
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    const name = result.stdout.trim().replace("fake:", "");
    const meta = JSON.parse(
      readFileSync(join(env.root, name, "sandbox.json"), "utf8"),
    );
    expect(meta.os).toBe("linux");
  });

  it("create without --os exits 125 and makes nothing", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--provider", "fake"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });
});
