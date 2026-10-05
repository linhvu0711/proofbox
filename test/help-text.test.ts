import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Help text", () => {
  afterEach(cleanupEnvs);

  it("create --help lists docker | namespace without the fake Provider", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--help"], {
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result.stdout).toContain("--provider docker | namespace");
    expect(result.stdout).not.toContain("| fake");
  });

  it("with PROOFBOX_FAKE_ROOT set, --provider also lists fake", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--help"]);
    // Then
    expect(result.stdout).toContain("--provider docker | namespace | fake");
  });

  it("auth login, logout, and token list the Providers", async () => {
    // Given
    const env = makeEnv();
    // When
    const results = await Promise.all(
      ["login", "logout", "token"].map((sub) =>
        runCli(env, ["auth", sub, "--help"], { unset: ["PROOFBOX_FAKE_ROOT"] }),
      ),
    );
    // Then
    for (const result of results) {
      expect(result.stdout).toContain(
        "One of the following: docker, namespace",
      );
    }
  });

  it("auth login --help lists us | eu for --region", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["auth", "login", "--help"]);
    // Then
    expect(result.stdout).toContain("--region us | eu");
  });

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
