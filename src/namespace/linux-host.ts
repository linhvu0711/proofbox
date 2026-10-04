import { Effect } from "effect";
import type { DockerClient } from "../docker/docker-client.ts";
import { sandboxInfoFromLabels } from "../docker/docker-provider.ts";
import { SandboxInfo, type SandboxRef } from "../provider.ts";
import type { NamespaceApi } from "./namespace-api.ts";
import {
  brandFor,
  describe,
  fail,
  gone,
  type NamespaceHost,
} from "./namespace-host.ts";
import type { Link } from "./ssh-link.ts";

// Left on a Linux host once its Sandbox is made. Docker removes the
// container at its Deadline (`--rm`) while the host lives on a while, so
// with no container this tells an expired Sandbox from one create never
// finished. The login's home: the host user may not own /var/lib.
export const MADE_MARK = '"$HOME/.proofbox-made"';

// The container takes the first six characters of the instance id.
export const containerOf = (ref: SandboxRef) =>
  `proofbox-${ref.name.slice(0, 6)}`;

// A Linux host runs the Sandbox in one Docker container.
export const makeLinuxHost = (_deps: {
  readonly api: NamespaceApi;
  readonly dockerFor: (link: Link) => DockerClient;
}): NamespaceHost => {
  const read = Effect.fn("linuxHost.read")(function* (
    link: Link,
    ref: SandboxRef,
  ) {
    const container = containerOf(ref);
    const result = yield* link.run(
      `docker inspect --format '{{json .Config.Labels}}|{{.State.Running}}' ${container} && docker exec -u root ${container} cat /run/proofbox/deadline`,
    );
    const stderr = result.stderr.toLowerCase();
    // The container can stop or be removed between inspect and the deadline
    // read; either way the Sandbox is gone rather than malformed.
    const removed =
      stderr.includes("no such object") || stderr.includes("no such container");
    const missing = removed || stderr.includes("is not running");
    if (result.exitCode !== 0 || missing) {
      if (removed) {
        // No container and no mark: create never made the Sandbox.
        const marked = yield* link.run(`test -e ${MADE_MARK}`);
        return yield* marked.exitCode === 0 ? gone(ref) : gone(ref, true);
      }
      if (missing) {
        return yield* gone(ref);
      }
      return yield* fail(
        `could not read the Sandbox: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const first = result.stdout.split("\n", 1)[0] ?? "";
    const separator = first.lastIndexOf("|");
    if (separator === -1) {
      return yield* fail(
        `could not read the Sandbox: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    if (first.slice(separator + 1).trim() !== "true") {
      return yield* gone(ref);
    }
    const seconds = Number(result.stdout.trim().split("\n").pop());
    if (!Number.isFinite(seconds)) {
      return yield* fail(
        `could not read the Deadline: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const labels = yield* Effect.try({
      try: () => JSON.parse(first.slice(0, separator)) as unknown,
      catch: (cause) => fail(describe(cause)),
    });
    const info = yield* sandboxInfoFromLabels(
      brandFor(ref),
      ref.name.slice(0, 6),
      labels,
      seconds,
    );
    return new SandboxInfo({
      name: ref.name,
      region: ref.region,
      os: info.os,
      createdAt: info.createdAt,
      idleSeconds: info.idleSeconds,
      deadline: info.deadline,
      maxLifeAt: info.maxLifeAt,
      base: info.base,
      size: info.size,
    });
  });

  return { os: "linux", read };
};
