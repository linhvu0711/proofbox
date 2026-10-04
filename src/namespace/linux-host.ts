import { Chunk, Duration, Effect, Schedule, Stream } from "effect";
import type { DockerClient } from "../docker/docker-client.ts";
import {
  LINUX_CHECKS,
  sandboxInfoFromLabels,
} from "../docker/docker-provider.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import { SandboxInfo, type SandboxRef } from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
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
export const makeLinuxHost = (deps: {
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

  // The SSH gateway reaches every Linux host.
  const reach = Effect.fn("linuxHost.reach")(function* (
    _ref: SandboxRef,
    _paths: KeeperPaths,
  ) {});

  // The container's Deadline file, `seconds` from the host's own clock.
  const writeDeadline = Effect.fn("linuxHost.writeDeadline")(function* (
    link: Link,
    ref: SandboxRef,
    seconds: number,
  ) {
    return yield* link.run(
      `docker exec -u root ${containerOf(ref)} sh -c 'tmp=/run/proofbox/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + $1 ))" > "$tmp" && mv "$tmp" /run/proofbox/deadline' sh ${seconds}`,
    );
  });

  // The VNC password one Live view uses; its finalizer stops x11vnc once
  // the last view closes.
  const livePassword = Effect.fn("linuxHost.livePassword")(function* (
    link: Link,
    ref: SandboxRef,
  ) {
    const docker = deps.dockerFor(link);
    const container = containerOf(ref);
    // The marker doubles as this session's slot and as the candidate
    // password; the flock'd script reuses an open session's password when
    // one is set, otherwise stores the candidate it reads from stdin —
    // never argv — and prints the settled password on stdout. One x11vnc
    // serves every viewer, so the password is one per sandbox.
    const session = makeSandboxName(8);
    const startX11vnc = docker
      .execStream(
        container,
        [
          "sh",
          "-c",
          'umask 077; mkdir -p ~/.vnc /tmp/proofbox-live; exec 9>/tmp/proofbox-live/.lock; flock -w 15 9 || exit 1; if [ -s /tmp/proofbox-live/.password ]; then pw=$(cat /tmp/proofbox-live/.password); else IFS= read -r pw || exit 1; printf "%s\\n%s\\ny\\n" "$pw" "$pw" | x11vnc -storepasswd ~/.vnc/passwd >/dev/null || exit 1; printf "%s\\n" "$pw" > /tmp/proofbox-live/.password; fi; pgrep -x x11vnc >/dev/null || x11vnc -display :99 -rfbauth ~/.vnc/passwd -rfbport 5900 -forever -shared -bg -o /tmp/x11vnc.log >/dev/null || { sleep 1; tail -c 1500 /tmp/x11vnc.log >&2; exit 1; }; touch "/tmp/proofbox-live/$0"; printf "%s" "$pw"',
          session,
        ],
        {
          stdin: Stream.make(new TextEncoder().encode(`${session}\n`)),
        },
      )
      .pipe(
        Stream.runCollect,
        Effect.map((events) => {
          let exitCode = 1;
          let stdout = "";
          let stderr = "";
          for (const event of Chunk.toReadonlyArray(events)) {
            if (event._tag === "Exit") {
              exitCode = event.code;
            } else if (event._tag === "Stdout") {
              stdout += Buffer.from(event.bytes).toString("utf8");
            } else if (event._tag === "Stderr") {
              stderr += Buffer.from(event.bytes).toString("utf8");
            }
          }
          return { exitCode, stdout, stderr };
        }),
        Effect.mapError((error) => `docker exec failed: ${error.message}`),
        Effect.filterOrFail(
          (result) => result.exitCode === 0 && result.stdout !== "",
          (result) => `x11vnc did not start: ${result.stderr.trim()}`,
        ),
        Effect.map((result) => result.stdout),
      );
    const password = yield* Effect.retry(
      startX11vnc,
      Schedule.spaced(Duration.seconds(1)).pipe(
        Schedule.upTo(Duration.seconds(10)),
      ),
    ).pipe(Effect.mapError((error) => fail(describe(error))));
    yield* Effect.addFinalizer(() =>
      docker
        .execText(container, "app", [
          "sh",
          "-c",
          'rm -f "/tmp/proofbox-live/$1"; if [ -z "$(ls -A /tmp/proofbox-live 2>/dev/null | grep -vxF .password | grep -vxF .lock)" ]; then rm -f /tmp/proofbox-live/.password ~/.vnc/passwd; pkill -x x11vnc; fi; true',
          "sh",
          session,
        ])
        .pipe(Effect.ignore),
    );
    return password;
  });

  return {
    os: "linux",
    via: "gateway",
    reach,
    read,
    writeDeadline,
    checks: LINUX_CHECKS,
    // The script runs in the Sandbox's container.
    call: (link, ref) => {
      const docker = deps.dockerFor(link);
      const container = containerOf(ref);
      return (argv, options) =>
        docker.execStream(container, argv, options, "root");
    },
    livePassword,
  };
};
