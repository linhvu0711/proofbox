import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { DockerClient } from "../src/docker/docker-client.ts";
import { makeDockerProvider } from "../src/docker/docker-provider.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { makeLinuxHost } from "../src/namespace/linux-host.ts";
import { makeMacHost } from "../src/namespace/mac-host.ts";
import type { NamespaceApi } from "../src/namespace/namespace-api.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import { sandboxFiles } from "../src/sandbox-file.ts";
import { nodeExecutor } from "./support/executor.ts";
import { nodeFs } from "./support/node-fs.ts";

// Building a Provider calls none of these; only its folders are asked.
const client: DockerClient = {
  serverArch: Effect.die("unused"),
  imageExists: () => Effect.die("unused"),
  pull: () => Effect.die("unused"),
  push: () => Effect.die("unused"),
  build: () => Effect.die("unused"),
  run: () => Effect.die("unused"),
  execText: () => Effect.die("unused"),
  execStream: () => Stream.die("unused"),
  inspect: () => Effect.die("unused"),
  listNames: Effect.die("unused"),
  remove: () => Effect.die("unused"),
};

const api: NamespaceApi = {
  create: () => Effect.die("unused"),
  wait: () => Effect.die("unused"),
  destroy: () => Effect.die("unused"),
  extend: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  sshConfig: () => Effect.die("unused"),
  ensureImageExpiry: () => Effect.die("unused"),
  checkToken: () => Effect.die("unused"),
  makeToken: () => Effect.die("unused"),
};

const namespace = () =>
  makeNamespaceProvider({
    executor: nodeExecutor,
    fs: nodeFs,
    api,
    login: Effect.die("unused"),
    openLink: () => Effect.die("unused"),
    forward: () => Effect.die("unused"),
    dockerFor: () => client,
    spawnDetached: () => Effect.die("unused"),
    hosts: {
      linux: makeLinuxHost({ api, dockerFor: () => client }),
      macos: makeMacHost({ openLink: () => Effect.die("unused") }),
    },
  });

describe("Sandbox files", () => {
  it("a Docker Sandbox keeps each file at its path", () => {
    // Given
    const provider = makeDockerProvider({ client });
    // When
    const files = sandboxFiles(provider, "abc123", "linux");
    // Then
    expect(files).toEqual({
      setupScript: "/var/lib/proofbox/setup",
      hashList: "/var/lib/proofbox/work-hashes.json",
      secrets: "/run/proofbox/secrets/env",
    });
  });

  it("a Namespace Linux Sandbox keeps each file at its path", () => {
    // Given
    const provider = namespace();
    // When
    const files = sandboxFiles(provider, "abc123def4567", "linux");
    // Then
    expect(files).toEqual({
      setupScript: "/var/lib/proofbox/setup",
      hashList: "/var/lib/proofbox/work-hashes.json",
      secrets: "/run/proofbox/secrets/env",
    });
  });

  it("a Namespace Mac keeps each file at its path", () => {
    // Given
    const provider = namespace();
    // When
    const files = sandboxFiles(provider, "abc123def4567", "macos");
    // Then
    expect(files).toEqual({
      setupScript: "/var/lib/proofbox/setup",
      hashList: "/var/lib/proofbox/work-hashes.json",
      secrets: "/var/run/proofbox-secrets/env",
    });
  });

  it("a fake Sandbox keeps each file under its root", () => {
    // Given: building the fake touches no disk
    const provider = makeFakeProvider({
      fs: nodeFs,
      root: "/tmp/pb-fake",
      watch: "none",
    });
    // When
    const files = sandboxFiles(provider, "abc123", "linux");
    // Then
    expect(files).toEqual({
      setupScript: "/tmp/pb-fake/abc123/state/setup",
      hashList: "/tmp/pb-fake/abc123/state/work-hashes.json",
      secrets: "/tmp/pb-fake/abc123/secrets/env",
    });
  });
});
