import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Recording and the Proof video", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  it("mark refuses a label over 60 characters", async () => {
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
    const label = "a".repeat(61);
    // When
    const result = await runCli(env, ["mark", id, label]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Bad Step mark "${label}": use 1 to 60 characters on one line, for example "step 3: save the post"\n`,
    );
  });

  it("record stop refuses a bad --max-size", async () => {
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
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--max-size",
      "10KB",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      'Bad --max-size "10KB": use a whole number with MB or GB, for example 800MB\n',
    );
  });

  it("record stop needs --out or --discard", async () => {
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
    const result = await runCli(env, ["record", "stop", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop needs --out <file>, or --discard to make no Proof video\n",
    );
  });

  it("record stop takes --out or --discard, not both", async () => {
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
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--discard",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop takes --out <file> or --discard, not both\n",
    );
  });
});
