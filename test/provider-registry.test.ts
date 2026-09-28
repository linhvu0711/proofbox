import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { spawnDetached } from "../src/spawn-detached.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Provider registry", () => {
  afterEach(cleanupEnvs);
  it("no file outside src/fake imports from src/fake", () => {
    // Given: every .ts file under src/, minus paths under src/fake/
    const files = readdirSync(join(repoRoot, "src"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `src/${path}`)
      .filter((path) => !path.startsWith("src/fake/"));
    // When
    const offenders = files.filter((path) =>
      /^\s*(import|export)\b[^;]*?\bfrom\s+["'][^"']*\/fake\//m.test(
        readFileSync(join(repoRoot, path), "utf8"),
      ),
    );
    // Then
    expect(offenders).toEqual([]);
  });

  it.effect("spawnDetached errors name the calling Provider", () =>
    Effect.gen(function* () {
      // Given: an arg with a NUL byte, which makes Node's spawn throw at once
      // When
      const error = yield* Effect.flip(
        spawnDetached("docker", "keeper/keeper-main", ["bad\u0000arg"]),
      );
      // Then
      expect(error.provider).toBe("docker");
      expect(error.message).toMatch(/^Provider docker failed: /);
    }),
  );

  it("with PROOFBOX_FAKE_ROOT set, create uses it and list names the Sandbox", async () => {
    // Given
    const env = makeEnv();
    // When
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const listed = await runCli(env, ["list"]);
    // Then
    expect(created.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(created.exitCode).toBe(0);
    expect(listed.stdout).toContain(created.stdout.trim());
  });

  it("without PROOFBOX_FAKE_ROOT list shows no fake Sandbox", async () => {
    // Given: a fake Sandbox on disk the CLI must not see
    const env = makeEnv();
    mkdirSync(join(env.root, "abc123"));
    writeFileSync(
      join(env.root, "abc123", "sandbox.json"),
      JSON.stringify({
        os: "linux",
        createdAt: new Date().toISOString(),
        idleSeconds: 900,
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        maxLifeAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    // When
    const listed = await runCli(env, ["list"], {
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toBe("");
    expect(listed.stderr).toBe("No live Sandboxes\n");
  });
});
