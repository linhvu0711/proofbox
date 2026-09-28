import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Capability", () => {
  afterEach(cleanupEnvs);

  it("create --os macos on fake is refused before anything is made", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "macos",
      "--provider",
      "fake",
    ]);
    // Then
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability os:macos; nothing was created\n",
    );
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
  });

  it("create with an unknown Provider names the Providers", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "nope",
    ]);
    // Then
    expect(result.stderr).toBe(
      'Unknown Provider "nope": use one of: docker, namespace, fake\n',
    );
    expect(result.exitCode).toBe(125);
  });
});
