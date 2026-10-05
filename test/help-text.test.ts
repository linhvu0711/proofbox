import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Help text", () => {
  afterEach(cleanupEnvs);

  it("help pages no longer list the built-in options", async () => {
    // Given
    const env = makeEnv();
    // When
    const results = await Promise.all(
      [["--help"], ["create", "--help"], ["auth"]].map((args) =>
        runCli(env, args),
      ),
    );
    // Then
    for (const result of results) {
      for (const option of [
        "--completions",
        "--log-level",
        "--wizard",
        "--version",
        "--help",
      ]) {
        expect(result.stdout).not.toContain(option);
      }
    }
  });

  it("--version still prints the version", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--version"]);
    // Then
    expect(result.stdout).toBe("0.0.0\n\n");
    expect(result.exitCode).toBe(0);
  });

  it("proofbox --help shows the app description", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--help"]);
    // Then
    expect(result.stdout).toContain(
      "rent a disposable Sandbox, drive its screen, and bring back a Proof video",
    );
  });
});
