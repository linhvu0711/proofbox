import { Chunk, Duration, Effect, Schedule, Stream } from "effect";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
} from "../docker/base-image.ts";
import type { DockerClient } from "../docker/docker-client.ts";
import {
  LINUX_CHECKS,
  makeDockerProvider,
  sandboxInfoFromLabels,
} from "../docker/docker-provider.ts";
import {
  type ProviderError,
  type ProviderUnavailableError,
  TokenExposedError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import { SandboxInfo, type SandboxRef } from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import type { Size } from "../size.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import type { NamespaceApi } from "./namespace-api.ts";
import {
  brandFor,
  describe,
  fail,
  gone,
  type MakeRequest,
  type NamespaceHost,
  sandboxId,
} from "./namespace-host.ts";
import { registryRefs } from "./registry-refs.ts";
import {
  pullSnapshot,
  pushSnapshot,
  snapshotRef,
  snapshotTag,
} from "./snapshot-image.ts";
import type { Link } from "./ssh-link.ts";

// Left on a Linux host once its Sandbox is made. Docker removes the
// container at its Deadline (`--rm`) while the host lives on a while, so
// with no container this tells an expired Sandbox from one create never
// finished. The login's home: the host user may not own /var/lib.
const MADE_MARK = '"$HOME/.proofbox-made"';

// The container takes the first six characters of the instance id.
const containerOf = (ref: SandboxRef) => `proofbox-${ref.name.slice(0, 6)}`;

const LINUX_SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 8 },
  { cpu: 8, ramGb: 16 },
  { cpu: 16, ramGb: 32 },
];
const DEFAULT_SIZE: Size = { cpu: 4, ramGb: 8 };
// The host holds Docker itself plus the Sandbox container; keep 1 GB of the
// Namespace size outside the container's limit so the host stays healthy.
const MEMORY_RESERVE_GB = 1;

// Each push and each use keeps a Base image version or a Snapshot at
// least two weeks; one that is not used for that long expires from the
// registry.
const IMAGE_KEEP_HOURS = 336;

// What a Linux host adds: only it has a container, so only it saves
// Snapshots.
export interface LinuxHost extends NamespaceHost {
  readonly baseVersion: Effect.Effect<string, ProviderError>;
  readonly saveSnapshot: (
    link: Link,
    ref: SandboxRef,
    fingerprint: string,
  ) => Effect.Effect<void, ProviderError | ProviderUnavailableError, Progress>;
}

// A Linux host runs the Sandbox in one Docker container.
export const makeLinuxHost = (deps: {
  readonly api: NamespaceApi;
  readonly dockerFor: (link: Link) => DockerClient;
}): LinuxHost => {
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

  const readTenant = Effect.fn("linuxHost.readTenant")(function* (link: Link) {
    const tenant = yield* link.run(
      `sed -n 's/.*"tenant_id": *"tenant_\\([a-z0-9]*\\)".*/\\1/p' /var/run/nsc/metadata.json`,
    );
    const registry = tenant.stdout.trim();
    if (tenant.exitCode !== 0 || registry === "") {
      return yield* fail("could not read the Namespace tenant on the host");
    }
    return registry;
  });

  // A Snapshot without an expiry is kept forever; failing to set one only
  // costs registry space, so it warns and goes on.
  const keepSnapshot = (link: Link, tag: string, progress: Progress) =>
    snapshotRef(link, tag).pipe(
      Effect.flatMap((ref) =>
        deps.api.ensureImageExpiry(ref, IMAGE_KEEP_HOURS),
      ),
      Effect.catchAll((error) =>
        progress.warn(`could not set the Snapshot expiry (${error.message})`),
      ),
    );

  // A Base image version without an expiry is kept forever too. Its index
  // and each child digest expire on their own; a Base the registry does
  // not hold is skipped. Every digest gets its call even when one fails,
  // so a child never expires before its index.
  const keepBase = (link: Link, tag: string, progress: Progress) =>
    registryRefs(link, tag).pipe(
      Effect.flatMap((refs) =>
        refs === "missing"
          ? Effect.void
          : Effect.validateAll(
              refs,
              (ref) => deps.api.ensureImageExpiry(ref, IMAGE_KEEP_HOURS),
              { discard: true },
            ).pipe(Effect.mapError((errors) => errors[0])),
      ),
      Effect.catchAll((error) =>
        progress.warn(`could not set the Base image expiry (${error.message})`),
      ),
    );

  // The Snapshot's image tag, pulled onto the host; undefined when the
  // Sandbox must start from the Base image instead.
  const pullStart = Effect.fn("linuxHost.pullStart")(function* (
    link: Link,
    tenant: string,
    fingerprint: string,
    progress: Progress,
  ) {
    const tag = snapshotTag(tenant, fingerprint);
    const pulled = yield* progress
      .step("pulling the Snapshot", pullSnapshot(link, tag))
      .pipe(
        Effect.catchAll((error) =>
          progress
            .warn(
              `could not pull the Snapshot (${error.message}); running the Setup script`,
            )
            .pipe(Effect.as("failed" as const)),
        ),
      );
    if (pulled !== "pulled") {
      return undefined;
    }
    yield* keepSnapshot(link, tag, progress);
    return tag;
  });

  // Makes the Sandbox's container on the host, from a Snapshot when one
  // is asked for and found, else from the Base image.
  const make = Effect.fn("linuxHost.make")(function* (
    link: Link,
    made: MakeRequest,
  ) {
    const { req, ref, size } = made;
    const progress = yield* Progress;
    const registry = yield* readTenant(link);
    const version = yield* baseImageVersion(BASE_IMAGE_DIR, LINUX_TOOL_BUNDLE);
    const baseTag = `nscr.io/${registry}/${baseImageTag(version)}`;
    const snapshotImage =
      req.snapshot === undefined
        ? undefined
        : yield* pullStart(link, registry, req.snapshot, progress);
    const inner = makeDockerProvider({
      client: deps.dockerFor(link),
      imageTag: snapshotImage ?? baseTag,
      registry: true,
      memoryReserveGb: MEMORY_RESERVE_GB,
      // Publish the VNC port for the Live view; the host has only a
      // private address, and the SSH gateway forwards onto that
      // address, so the publish must cover it — loopback binds are
      // unreachable.
      runArgs: [
        "-p",
        "5900:5900",
        ...(snapshotImage === undefined
          ? []
          : ["--label", `proofbox.snapshot=${req.snapshot}`]),
      ],
      brand: brandFor(ref),
    });
    const info = yield* inner.create({
      ...req,
      size,
      name: ref.name.slice(0, 6),
      maxLifeAt: made.maxLifeAt,
    });
    // A Snapshot's Fingerprint holds the Base version, so this is its
    // Base too.
    yield* keepBase(link, baseTag, progress);
    // The Base image must hide the host's workload token from user code:
    // neither the token file nor the link-local token service may answer.
    const docker = deps.dockerFor(link);
    const container = containerOf(ref);
    yield* progress.step(
      "checking the Namespace token is out of reach",
      Effect.gen(function* () {
        const file = yield* docker.execText(container, "app", [
          "sh",
          "-c",
          "test ! -e /var/run/nsc/token.json",
        ]);
        if (file.exitCode !== 0) {
          return yield* new TokenExposedError({
            id: sandboxId(ref),
            what: "the token file",
          });
        }
        const service = yield* docker.execText(container, "app", [
          "sh",
          "-c",
          "! curl -s -m 3 -o /dev/null http://169.254.169.42/",
        ]);
        if (service.exitCode !== 0) {
          return yield* new TokenExposedError({
            id: sandboxId(ref),
            what: "the token service",
          });
        }
      }),
    );
    const marked = yield* link.run(`touch ${MADE_MARK}`);
    if (marked.exitCode !== 0) {
      return yield* fail(
        `could not mark the host: ${(marked.stderr || marked.stdout).trim()}`,
      );
    }
    return new SandboxInfo({
      name: ref.name,
      region: ref.region,
      os: info.os,
      createdAt: info.createdAt,
      idleSeconds: info.idleSeconds,
      deadline: info.deadline,
      maxLifeAt: info.maxLifeAt,
      base: info.base,
      snapshot: info.snapshot,
      size: info.size,
    });
  });

  // The Snapshot holds the container's disk; the Secrets live in a tmpfs,
  // which docker commit leaves out.
  const saveSnapshot = Effect.fn("linuxHost.saveSnapshot")(function* (
    link: Link,
    ref: SandboxRef,
    fingerprint: string,
  ) {
    const progress = yield* Progress;
    const tag = snapshotTag(yield* readTenant(link), fingerprint);
    yield* pushSnapshot(link, containerOf(ref), tag);
    yield* keepSnapshot(link, tag, progress);
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
    offer: {
      sizes: LINUX_SIZES,
      features: new Set([
        "desktop",
        "recording",
        "live-view",
        "secrets",
        "snapshot",
      ]),
    },
    defaultSize: DEFAULT_SIZE,
    machine: { arch: "amd64", selectors: [] },
    make,
    folders: { state: "/var/lib/proofbox", secrets: "/run/proofbox/secrets" },
    baseVersion: baseImageVersion(BASE_IMAGE_DIR, LINUX_TOOL_BUNDLE),
    saveSnapshot,
  };
};
