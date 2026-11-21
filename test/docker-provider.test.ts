import { readdirSync } from "node:fs";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { afterEach, describe, expect } from "vitest";
import type { DockerClient } from "../src/docker/docker-client.ts";
import {
  makeDockerProvider,
  type ProviderBrand,
  sandboxInfoFromLabels,
} from "../src/docker/docker-provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { unusedDockerClient } from "./support/docker-clients.ts";
import { nodeFs } from "./support/node-fs.ts";

const NOT_RUNNING = "Docker is not running; start Docker and try again\n";

describe("Docker not running", () => {
  afterEach(cleanupEnvs);

  it("create with Docker not running says so and leaves nothing behind", async () => {
    // Given: makeEnv points DOCKER_HOST at a socket that does not exist
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "docker",
    ]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.runtime)).toEqual([]);
  });

  it("create with no docker binary says Docker is not running", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "docker"],
      { set: { PATH: "/nonexistent" } },
    );
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.runtime)).toEqual([]);
  });

  it("list with Docker not running still works", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["list"]);
    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("No live Sandboxes\n");
    expect(result.exitCode).toBe(0);
  });

  it("exec on a docker Sandbox with Docker not running says so", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "docker:abc123", "--", "true"]);
    // Then
    expect(result.stderr).toBe(NOT_RUNNING);
    expect(result.exitCode).toBe(125);
  });
});

describe("Docker labels", () => {
  const brand: ProviderBrand = {
    provider: "docker",
    id: (name) => `docker:${name}`,
  };
  const labels = (idleSeconds: string) => ({
    "proofbox.name": "box",
    "proofbox.os": "linux",
    "proofbox.created-at": "2026-01-01T00:00:00Z",
    "proofbox.idle-seconds": idleSeconds,
    "proofbox.max-life-at": "2099-01-01T00:00:00Z",
  });

  it.effect.each([{ label: "0" }, { label: "-5" }, { label: "1.5" }])(
    "an idle-seconds label of $label fails to decode",
    ({ label }) =>
      Effect.gen(function* () {
        // Given: a container whose idle label is not a whole positive number
        // When
        const error = yield* Effect.flip(
          sandboxInfoFromLabels(
            brand,
            "box",
            labels(label),
            new Date(4_000_000_000_000),
          ),
        );
        // Then
        expect(error).toMatchObject({
          _tag: "ProviderError",
          provider: "docker",
        });
      }),
  );

  it.effect("an idle-seconds label of 300 decodes to 300 seconds", () =>
    Effect.gen(function* () {
      // Given: a container with a good idle label
      // When
      const info = yield* sandboxInfoFromLabels(
        brand,
        "box",
        labels("300"),
        new Date(4_000_000_000_000),
      );
      // Then
      expect(info.idleSeconds).toBe(300);
    }),
  );
});

describe("Docker Deadline file", () => {
  // A container that runs and holds these labels, whose Deadline file
  // reads as `deadline`.
  const fakeClient = (deadline: string): DockerClient => ({
    ...unusedDockerClient,
    execText: () =>
      Effect.succeed({ exitCode: 0, stdout: deadline, stderr: "" }),
    inspect: () =>
      Effect.succeed(
        Option.some({
          labels: {
            "proofbox.name": "abc123",
            "proofbox.os": "linux",
            "proofbox.created-at": "2026-01-01T00:00:00Z",
            "proofbox.idle-seconds": "300",
            "proofbox.max-life-at": "2099-01-01T00:00:00Z",
          },
          running: true,
        }),
      ),
  });

  it.effect(
    "get on a Docker Sandbox whose Deadline file is empty fails with could not read the Deadline",
    () =>
      Effect.gen(function* () {
        // Given: a running Sandbox whose Deadline file is empty
        const provider = makeDockerProvider({
          client: fakeClient(""),
          fs: nodeFs,
        });
        // When
        const error = yield* Effect.flip(
          provider.get({ name: "abc123", region: undefined }),
        );
        // Then
        expect(error).toMatchObject({
          _tag: "ProviderError",
          provider: "docker",
          reason: "could not read the Deadline: ",
        });
      }),
  );

  it.effect("connect to a removed Docker container fails as gone", () =>
    Effect.gen(function* () {
      // Given: Docker has no container for the Sandbox
      const provider = makeDockerProvider({
        client: {
          ...fakeClient("9999999999\n"),
          inspect: () => Effect.succeed(Option.none()),
        },
        fs: nodeFs,
      });
      // When
      const error = yield* Effect.flip(
        provider.connect({ name: "abc123", region: undefined }),
      );
      // Then
      expect({ _tag: error._tag, message: error.message }).toEqual({
        _tag: "SandboxGoneError",
        message: "Sandbox docker:abc123 is gone",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
  );
});
