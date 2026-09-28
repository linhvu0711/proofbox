import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const NOT_RUNNING = "Docker is not running; start Docker and try again\n";

describe("Docker not running", () => {
  afterEach(cleanupEnvs);

  it("create with Docker not running says so and leaves nothing behind", async () => {
    // Given: makeEnv points DOCKER_HOST at a socket that does not exist
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "docker",
    ]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.runtime)).toEqual([]);
  });

  it("create with no docker binary says Docker is not running", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "docker"],
      { set: { PATH: "/nonexistent" } },
    );
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.runtime)).toEqual([]);
  });

  it("list with Docker not running still works", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["list"]);
    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("No live Sandboxes\n");
    expect(result.exitCode).toBe(0);
  });

  it("exec on a docker Sandbox with Docker not running says so", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "exec",
      "docker:abc123",
      "--",
      "true",
    ]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
  });
});
