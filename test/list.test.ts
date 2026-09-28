import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const writeFakeSandbox = (root: string, name: string, idleSeconds = 900) => {
  mkdirSync(join(root, name, "home"), { recursive: true });
  writeFileSync(
    join(root, name, "sandbox.json"),
    `${JSON.stringify({
      os: "linux",
      idleSeconds,
      createdAt: "2999-01-01T00:00:00.000Z",
      deadline: "2999-01-01T00:15:00.000Z",
      maxLifeAt: "2999-01-01T03:00:00.000Z",
    })}\n`,
  );
};

describe("list", () => {
  afterEach(cleanupEnvs);

  it("list reads Sandboxes from the Provider, not local state", async () => {
    // Given: a Sandbox folder written by hand, no CLI run
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    // When
    const result = await runCli(env, ["list"]);
    // Then
    expect(result.stdout).toBe(
      "fake:qqqqqq  linux  deadline 2999-01-01T00:15:00Z  max life 2999-01-01T03:00:00Z\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("list refuses a Sandbox whose idle time is not a whole number of seconds", async () => {
    // Given: hand-written Sandboxes with a negative and a fractional idle time
    for (const idle of [-3, 1.5]) {
      const env = makeEnv();
      writeFakeSandbox(env.root, "qqqqqq", idle);
      // When
      const result = await runCli(env, ["list"]);
      // Then
      expect(result.stderr).toContain('["idleSeconds"]');
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(125);
    }
  });

  it("list --json gives id, os, deadline, and maxLife", async () => {
    // Given: the same hand-written qqqqqq Sandbox
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    // When
    const result = await runCli(env, ["list", "--json"]);
    // Then
    expect(result.stdout).toBe(
      '[{"id":"fake:qqqqqq","os":"linux","deadline":"2999-01-01T00:15:00Z","maxLife":"2999-01-01T03:00:00Z"}]\n',
    );
    expect(result.exitCode).toBe(0);
  });

  it("list with no Sandbox says so on stderr", async () => {
    // Given
    const env = makeEnv();
    // When
    const plain = await runCli(env, ["list"]);
    const json = await runCli(env, ["list", "--json"]);
    // Then
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toBe("No live Sandboxes\n");
    expect(plain.exitCode).toBe(0);
    expect(json.stdout).toBe("[]\n");
  });
});
