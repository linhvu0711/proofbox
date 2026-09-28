import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";

const makeHome = (config?: string): string => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-home-"));
  trackTempDir(home);
  if (config !== undefined) {
    const dir = join(home, ".config", "proofbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config"), config);
  }
  return home;
};

describe("Provider config", () => {
  afterEach(cleanupEnvs);

  it("create with no --provider uses the config file's Provider for the OS", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome('{"linux": "fake"}');
    // When
    const result = await runCli(env, ["create", "--os", "linux"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.exitCode).toBe(0);
  });

  it("with no config file both OSes map to namespace", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const macos = await runCli(env, ["create", "--os", "macos"], {
      set: { HOME: home },
    });
    const linux = await runCli(
      env,
      ["create", "--os", "linux", "--size", "2x4"],
      { set: { HOME: home } },
    );
    // Then
    expect(macos.stderr).toBe(
      "Provider namespace lacks the Capability os:macos; nothing was created\n",
    );
    expect(macos.exitCode).toBe(125);
    expect(linux.stderr).toBe(
      "Provider namespace does not offer the size 2x4; use one of: 4x8, 8x16, 16x32\n",
    );
    expect(linux.exitCode).toBe(125);
  });

  it("--provider overrides the config file", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome('{"linux": "namespace"}');
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.exitCode).toBe(0);
  });

  it("a config file with an unknown key is refused", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome('{"linx": "fake"}');
    // When
    const result = await runCli(env, ["create", "--os", "linux"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      `Bad config ${home}/.config/proofbox/config: unknown key "linx"; use JSON like {"linux": "docker", "macos": "namespace"}\n`,
    );
    expect(result.exitCode).toBe(125);
  });
});
