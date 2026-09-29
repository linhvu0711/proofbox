import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Capability", () => {
  afterEach(cleanupEnvs);

  it("create --os macos --env-file on namespace is refused before anything is made", async () => {
    // Given
    const env = makeEnv();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "A=1\n", { mode: 0o600 });
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "macos",
      "--provider",
      "namespace",
      "--env-file",
      file,
    ]);
    rmSync(dir, { recursive: true, force: true });
    // Then
    expect(result.stderr).toBe(
      "Provider namespace lacks the Capability secrets on macos; nothing was created\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      readdirSync(env.runtime).filter((name) => name.startsWith("ns-")),
    ).toEqual([]);
  });

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
