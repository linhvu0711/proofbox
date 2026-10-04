import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  it("screenshot on a Provider with no desktop is refused", async () => {
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
    const out = join(env.root, "shot.png");
    // When
    const result = await runCli(env, ["screenshot", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
    expect(existsSync(out)).toBe(false);
  });

  it("click on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["click", id, "10", "10"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("drag on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["drag", id, "10", "10", "20", "20"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("key on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["key", id, "ctrl+s"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("scroll on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["scroll", id, "10", "10", "down"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("type on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["type", id, "hello"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("record start on a Provider with no desktop is refused", async () => {
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
    const result = await runCli(env, ["record", "start", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no Recording was started\n",
    );
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
