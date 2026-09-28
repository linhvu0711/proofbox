import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Sandbox id", () => {
  afterEach(cleanupEnvs);

  it("a malformed id names the id and the form", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Bad Sandbox id "abc123": use the form <provider>:<name>, for example ns:abc123\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("an empty name is malformed", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "fake:", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Bad Sandbox id "fake:": use the form <provider>:<name>, for example ns:abc123\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("an unknown Provider names the id and the form", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "nope:abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Unknown Provider "nope" in Sandbox id "nope:abc123": use the form <provider>:<name> with a Provider from: docker, ns, fake\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("exec on a name the Provider does not hold says it is gone", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "fake:zzzzzz", "--", "true"]);
    // Then
    expect(result.stderr).toBe("Sandbox fake:zzzzzz is gone\n");
    expect(result.exitCode).toBe(125);
  });
});
