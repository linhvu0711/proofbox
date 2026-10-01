import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { type Provider, providerEntry } from "../src/provider.ts";
import { fileStem, resolveSandboxId } from "../src/sandbox-id.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Sandbox id", () => {
  afterEach(cleanupEnvs);

  it.effect("a regional id hands its region over apart", () =>
    Effect.gen(function* () {
      // Given: a Providers map with the Namespace Provider shape
      const namespaceLike: Provider = {
        name: "namespace",
        idPrefix: "ns",
        login: { _tag: "None" },
        regions: { known: ["us", "eu"], fallback: "us" },
        offers: {},
        create: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        list: Effect.die("unused"),
        delete: () => Effect.die("unused"),
        stateDir: () => "",
        secretsDir: () => "",
        connect: () => Effect.die("unused"),
      };
      // When
      const resolved = yield* resolveSandboxId(
        "ns:eu:abc123",
        new Map([["namespace", providerEntry(namespaceLike)]]),
      );
      // Then
      expect({
        prefix: resolved.prefix,
        region: resolved.region,
        name: resolved.name,
      }).toEqual({ prefix: "ns", region: "eu", name: "abc123" });
    }),
  );

  it("a sandbox's file stem keeps the region inside", () => {
    expect(fileStem({ name: "abc123", region: "eu" })).toBe("eu:abc123");
    expect(fileStem({ name: "abc123", region: undefined })).toBe("abc123");
  });

  it("a malformed id names the id and the form", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Bad Sandbox id "abc123": use the form <provider>:<name>, for example ns:us:abc123\n',
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
      'Bad Sandbox id "fake:": use the form <provider>:<name>, for example ns:us:abc123\n',
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

  it("help shows an ns Sandbox id", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["delete", "--help"]);
    // Then
    expect(result.stdout).toContain("a Sandbox id, for example ns:us:abc123");
    expect(result.stdout).not.toContain("fake:");
  });

  it("an ns id with no region says it has no region", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "ns:abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Sandbox id "ns:abc123" has no region: use the form ns:<region>:<name>, for example ns:us:abc123\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("an ns id with an unknown region names the known ones", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "ns:mars:abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Unknown region "mars" in Sandbox id "ns:mars:abc123": use one of: us, eu\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("a region on a Provider with no regions is malformed", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "fake:us:abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(
      'Bad Sandbox id "fake:us:abc123": use the form <provider>:<name>, for example ns:us:abc123\n',
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
