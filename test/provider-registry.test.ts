import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { Providers } from "../src/provider.ts";
import { ProvidersLive } from "../src/provider-registry.ts";
import { spawnDetached } from "../src/spawn-detached.ts";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Env for a CLI run that records every module it resolves to `loads`.
const recordLoads = (env: CliEnv) => {
  const loads = join(env.root, "loads.txt");
  const hook = pathToFileURL(join(repoRoot, "test/support/record-loads.ts"));
  return {
    loads,
    set: { NODE_OPTIONS: `--import=${hook.href}`, PROOFBOX_TEST_LOADS: loads },
  };
};

// The modules of the Namespace Provider's own libraries in a loads file.
const providerLibs = (loads: string) =>
  readFileSync(loads, "utf8")
    .split("\n")
    .filter((url) =>
      /\/node_modules\/(@namespacelabs\/sdk|@connectrpc\/|@bufbuild\/protobuf)\//.test(
        url,
      ),
    );

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

  it("without PROOFBOX_FAKE_ROOT the Unknown Provider list names docker and namespace", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "nope"],
      { unset: ["PROOFBOX_FAKE_ROOT"] },
    );
    // Then
    expect(result.stderr).toBe(
      'Unknown Provider "nope": use one of: docker, namespace\n',
    );
    expect(result.exitCode).toBe(125);
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

  it("exec on a fake Sandbox loads no Namespace libraries", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const { loads, set } = recordLoads(env);
    // When
    const result = await runCli(
      env,
      ["exec", created.stdout.trim(), "--", "true"],
      { set },
    );
    // Then
    expect(result.exitCode).toBe(0);
    expect(providerLibs(loads)).toEqual([]);
    expect(readFileSync(loads, "utf8")).toContain("/node_modules/effect/");
  });

  it("exec on a Docker Sandbox loads no Namespace libraries", async () => {
    // Given: no Docker daemon, so exec fails after it picks the Provider
    const env = makeEnv();
    const { loads, set } = recordLoads(env);
    // When
    const result = await runCli(env, ["exec", "docker:abc123", "--", "true"], {
      set,
    });
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain(
      "Docker is not running; start Docker and try again",
    );
    expect(providerLibs(loads)).toEqual([]);
    expect(readFileSync(loads, "utf8")).toContain("/node_modules/effect/");
  });

  it.effect("each Provider entry names the id prefix its Provider uses", () =>
    Effect.gen(function* () {
      // Given
      const providers = yield* Providers;
      // When
      const pairs: Array<[string, string]> = [];
      for (const entry of providers.values()) {
        const provider = yield* entry.load;
        pairs.push([entry.idPrefix, provider.idPrefix]);
      }
      // Then
      expect(pairs).toEqual([
        ["docker", "docker"],
        ["ns", "ns"],
        ["fake", "fake"],
      ]);
    }).pipe(
      Effect.provide(ProvidersLive),
      Effect.provide(NodeContext.layer),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([["PROOFBOX_FAKE_ROOT", makeEnv().root]]),
        ),
      ),
    ),
  );
});
