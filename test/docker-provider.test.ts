import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const NOT_RUNNING = "Docker is not running; start Docker and try again\n";

describe("Docker not running", () => {
  afterEach(cleanupEnvs);

  it("create with Docker down says so", async () => {
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
    expect(result.stderr.endsWith(NOT_RUNNING)).toBe(true);
    expect(result.exitCode).toBe(125);
  });

  it("exec on a docker Sandbox with Docker down says so", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "exec",
      "docker:zzzzzz",
      "--",
      "true",
    ]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
  });

  it("delete a docker Sandbox with Docker down says so", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["delete", "docker:zzzzzz"]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
  });

  it("list with Docker down still shows fake Sandboxes", async () => {
    // Given: a live fake Sandbox and a dead Docker
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    expect(created.exitCode).toBe(0);
    // When
    const listed = await runCli(env, ["list"]);
    // Then
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(created.stdout.trim());
  });
});
