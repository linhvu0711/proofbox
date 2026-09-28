import { execFile } from "node:child_process";
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Chunk, Clock, Duration, Effect, Schedule, Stream } from "effect";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
} from "../docker/base-image.ts";
import type { DockerClient } from "../docker/docker-client.ts";
import {
  makeDockerProvider,
  sandboxInfoFromLabels,
} from "../docker/docker-provider.ts";
import {
  ProviderError,
  ProviderLimitError,
  type ProviderUnavailableError,
  SandboxGoneError,
  TokenExposedError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import { type Os, type Provider, SandboxInfo } from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import { formatSize, type Size } from "../size.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import { macExec, prepareMac, readMac, writeMacDeadline } from "./mac-host.ts";
import type { NscClient } from "./nsc-client.ts";
import {
  pullSnapshot,
  pushSnapshot,
  snapshotRef,
  snapshotTag,
} from "./snapshot-image.ts";
import type { Link, OpenLink } from "./ssh-link.ts";

const LINUX_SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 8 },
  { cpu: 8, ramGb: 16 },
  { cpu: 16, ramGb: 32 },
];
const DEFAULT_SIZE: Size = { cpu: 4, ramGb: 8 };
const MACOS_SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 7 },
  { cpu: 6, ramGb: 14 },
];
const DEFAULT_MACOS_SIZE: Size = { cpu: 4, ramGb: 7 };
// Every Known line about the Mac was proved on macOS 26; with no selector
// Namespace gives 15.
const MACOS_SELECTORS = { "macos.version": "26.x" } as const;

// The host holds Docker itself plus the Sandbox container; keep 1 GB of the
// Namespace size outside the container's limit so the host stays healthy.
const MEMORY_RESERVE_GB = 1;

// Each save and each reuse keeps a Snapshot at least two weeks; one that
// is not used for that long expires from the registry.
const SNAPSHOT_KEEP_HOURS = 336;

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const exec = promisify(execFile);

export const makeNamespaceProvider = (deps: {
  readonly nsc: NscClient;
  readonly openLink: OpenLink;
  readonly dockerFor: (link: Link) => DockerClient;
  readonly spawnDetached: (
    provider: string,
    rel: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProviderError>;
}): Provider => {
  const nsc = deps.nsc;
  const fail = (reason: string) =>
    new ProviderError({ provider: "namespace", reason });
  const gone = (name: string) => new SandboxGoneError({ id: `ns:${name}` });
  const brandFor = (name: string) => ({
    provider: "namespace",
    id: () => `ns:${name}`,
  });
  const paths = (name: string) => keeperPaths({ provider: "ns", name });
  const containerOf = (name: string) => `proofbox-${name.slice(0, 6)}`;
  // The host's OS, written at create; a host made before macOS existed has
  // no file and is Linux.
  const osOf = (name: string) =>
    Effect.gen(function* () {
      const file = (yield* paths(name)).os;
      const text = yield* Effect.promise(() =>
        readFile(file, "utf8").catch(() => "linux"),
      );
      return (text.trim() === "macos" ? "macos" : "linux") satisfies Os;
    });

  // Link bring-up can outlast a short host Deadline, so every open first
  // bumps the host's own lifetime — detached, since nsc needs no link.
  const openLink = (name: string, owner: "cli" | "keeper") =>
    Effect.gen(function* () {
      yield* deps.spawnDetached("namespace", "namespace/extend-main", [
        name,
        "120",
      ]);
      return yield* deps.openLink(name, yield* paths(name), owner);
    });

  // Every `run` or Docker call needs the ssh link; open a cli-owned one per
  // call so the Keeper's ControlMaster path stays the Keeper's alone.
  const withCliLink = <A, E>(
    name: string,
    use: (link: Link) => Effect.Effect<A, E>,
  ): Effect.Effect<
    A,
    E | ProviderError | ProviderUnavailableError | SandboxGoneError
  > =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = yield* openLink(name, "cli");
        return yield* use(link);
      }),
    );

  const readTenant = (link: Link) =>
    Effect.gen(function* () {
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
      Effect.flatMap((ref) => nsc.ensureImageExpiry(ref, SNAPSHOT_KEEP_HOURS)),
      Effect.catchAll((error) =>
        progress.warn(`could not set the Snapshot expiry (${error.message})`),
      ),
    );

  // The Snapshot's image tag, pulled onto the host; undefined when the
  // Sandbox must start from the Base image instead.
  const pullStart = (
    link: Link,
    tenant: string,
    fingerprint: string,
    progress: Progress,
  ) =>
    Effect.gen(function* () {
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

  const getWith = (link: Link, name: string) =>
    Effect.gen(function* () {
      const container = containerOf(name);
      const result = yield* link.run(
        `docker inspect --format '{{json .Config.Labels}}|{{.State.Running}}' ${container} && docker exec -u root ${container} cat /run/proofbox/deadline`,
      );
      const stderr = result.stderr.toLowerCase();
      // The container can stop or be removed between inspect and the deadline
      // read; either way the Sandbox is gone rather than malformed.
      const missing =
        stderr.includes("no such object") ||
        stderr.includes("no such container") ||
        stderr.includes("is not running");
      if (result.exitCode !== 0 || missing) {
        if (missing) {
          return yield* gone(name);
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
        return yield* gone(name);
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
        brandFor(name),
        name.slice(0, 6),
        labels,
        seconds,
      );
      return new SandboxInfo({
        name,
        os: info.os,
        createdAt: info.createdAt,
        idleSeconds: info.idleSeconds,
        deadline: info.deadline,
        maxLifeAt: info.maxLifeAt,
        base: info.base,
        size: info.size,
      });
    });

  const getAs = (os: Os, name: string) =>
    withCliLink(name, (link) =>
      os === "macos" ? readMac(link, name) : getWith(link, name),
    );

  const get = (name: string) =>
    Effect.gen(function* () {
      return yield* getAs(yield* osOf(name), name);
    });

  const extend = (name: string, deadline: Date) =>
    Effect.gen(function* () {
      const seconds = Math.ceil(
        (deadline.getTime() - (yield* Clock.currentTimeMillis)) / 1000,
      );
      // The host side first and detached: the nsc call needs no link, and the
      // link write below can spend a while in bring-up.
      yield* deps.spawnDetached("namespace", "namespace/extend-main", [
        name,
        String(seconds),
      ]);
      const os = yield* osOf(name);
      const written = yield* withCliLink(name, (link) =>
        os === "macos"
          ? writeMacDeadline(link, seconds)
          : link.run(
              `docker exec -u root ${containerOf(name)} sh -c 'tmp=/run/proofbox/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + $1 ))" > "$tmp" && mv "$tmp" /run/proofbox/deadline' sh ${seconds}`,
            ),
      );
      if (written.exitCode !== 0) {
        if (written.stderr.toLowerCase().includes("no such container")) {
          return yield* gone(name);
        }
        return yield* fail(
          `could not write the Deadline: ${written.stderr.trim()}`,
        );
      }
    });

  // Each OS is its own label, so a host is listed with the OS it runs.
  const listHosts = Effect.gen(function* () {
    const [linux, macos] = yield* Effect.all(
      [
        nsc.list({ "proofbox.os": "linux" }),
        nsc.list({ "proofbox.os": "macos" }),
      ],
      { concurrency: 2 },
    );
    return [
      ...linux.map((instance) => ({ os: "linux" as const, instance })),
      ...macos.map((instance) => ({ os: "macos" as const, instance })),
    ];
  });

  const list = Effect.gen(function* () {
    const hosts = yield* listHosts;
    const instances = hosts.map((host) => host.instance);
    // Hosts can expire without a delete; their keypair and Max-life cap
    // stay in the runtime dir, so drop the files of any host that is gone.
    const alive = new Set(instances.map((instance) => instance.clusterId));
    const dir = (yield* paths("__probe__")).dir;
    yield* Effect.promise(async () => {
      const entries = await readdir(dir).catch(() => [] as string[]);
      // Only files at least ten minutes old are pruned: an ns-new-* staging
      // key belongs to a create in flight, and a host registered moments ago
      // can still be ahead of the nsc list snapshot.
      const stale = async (file: string) => {
        const info = await stat(join(dir, file)).catch(() => null);
        return info !== null && Date.now() - info.mtimeMs > 600_000;
      };
      await Promise.all(
        entries
          .map((entry) => /^ns-(.+)\.key$/.exec(entry)?.[1])
          .filter(
            (name): name is string =>
              name !== undefined && !name.startsWith("new-"),
          )
          .filter((name) => !alive.has(name))
          .map(async (name) => {
            if (!(await stale(`ns-${name}.key`))) return;
            await Promise.all(
              [".key", ".key.pub", ".max-life", ".os", ".ctl", ".sock"].map(
                (suffix) =>
                  rm(join(dir, `ns-${name}${suffix}`), { force: true }).catch(
                    () => {},
                  ),
              ),
            );
          }),
      ).then(() => {});
    });
    const infos = yield* Effect.forEach(
      hosts,
      ({ os, instance }) =>
        getAs(os, instance.clusterId).pipe(
          Effect.catchTag("SandboxGoneError", () => Effect.succeed(undefined)),
        ),
      { discard: false },
    );
    return infos.filter((info) => info !== undefined);
  }).pipe(
    // A Provider that cannot list (nsc missing, not logged in) reports
    // none rather than breaking `list` for every other Provider.
    Effect.catchTag("ProviderUnavailableError", () => Effect.succeed([])),
    Effect.catchTag("SandboxGoneError", () => Effect.succeed([])),
  );

  const del = (name: string) =>
    Effect.gen(function* () {
      const hosts = yield* listHosts.pipe(
        Effect.catchTag("SandboxGoneError", () => Effect.succeed([])),
      );
      const present = hosts.some((host) => host.instance.clusterId === name);
      if (present) {
        yield* nsc
          .destroy(name)
          .pipe(Effect.catchTag("SandboxGoneError", () => Effect.void));
      }
      // Hosts that expire on their own never reach destroy, so the local
      // keypair and Max-life cap are removed whether or not the host is
      // still listed.
      const dir = yield* paths(name);
      yield* Effect.promise(() =>
        Promise.all([
          rm(dir.key, { force: true }).catch(() => {}),
          rm(`${dir.key}.pub`, { force: true }).catch(() => {}),
          rm(dir.maxLife, { force: true }).catch(() => {}),
          rm(dir.os, { force: true }).catch(() => {}),
        ]).then(() => {}),
      );
      return present ? ("deleted" as const) : ("gone" as const);
    });

  const create = (req: {
    readonly os: Parameters<Provider["create"]>[0]["os"];
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
    readonly snapshot?: string | undefined;
  }) =>
    Effect.gen(function* () {
      yield* nsc.checkLogin.pipe(
        Effect.catchTag("SandboxGoneError", (error) =>
          Effect.fail(fail(error.message)),
        ),
      );
      const macos = req.os === "macos";
      const size = req.size ?? (macos ? DEFAULT_MACOS_SIZE : DEFAULT_SIZE);
      const staged = yield* paths(`new-${process.pid}`);
      const keyBase = join(staged.dir, `ns-new-${process.pid}.key`);
      const cidfile = join(staged.dir, `ns-new-${process.pid}.cid`);
      // Whatever part of the make is left — key files, the host — leaves
      // nothing behind on a failed create.
      const createToken = makeSandboxName();
      let hostId: string | undefined;
      const cleanup = Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            rm(keyBase, { force: true }).catch(() => {}),
            rm(`${keyBase}.pub`, { force: true }).catch(() => {}),
            rm(cidfile, { force: true }).catch(() => {}),
          ]).then(() => {}),
        );
        if (hostId !== undefined) {
          const hostPaths = yield* paths(hostId);
          yield* Effect.promise(() =>
            Promise.all([
              rm(hostPaths.key, { force: true }).catch(() => {}),
              rm(`${hostPaths.key}.pub`, { force: true }).catch(() => {}),
              rm(hostPaths.maxLife, { force: true }).catch(() => {}),
              rm(hostPaths.os, { force: true }).catch(() => {}),
            ]).then(() => {}),
          );
          yield* nsc.destroy(hostId).pipe(Effect.orElseSucceed(() => {}));
        }
      });
      return yield* Effect.gen(function* () {
        const progress = yield* Progress;
        yield* Effect.tryPromise({
          try: () =>
            exec("ssh-keygen", [
              "-q",
              "-t",
              "ed25519",
              "-N",
              "",
              "-C",
              "proofbox",
              "-f",
              keyBase,
            ]).then(() => {}),
          catch: (cause) => fail(`ssh-keygen failed: ${describe(cause)}`),
        });
        const durationSeconds = Math.min(
          Duration.toSeconds(req.idle) + 60,
          Duration.toSeconds(req.maxLife),
        );
        // Max life counts from the create call, so the Sandbox's
        // maxLifeAt, the host-cap file the detached pushes read, and the
        // provisioning keepalive all stop at the same instant — anchor it
        // before the host is created, not after.
        const maxLifeSeconds = Math.floor(
          (Date.now() + Duration.toMillis(req.maxLife)) / 1000,
        );
        const id = yield* nsc
          .create({
            machineType: macos
              ? `macos/arm64:${formatSize(size)}`
              : `linux/amd64:${formatSize(size)}`,
            durationSeconds,
            sshKeyFile: `${keyBase}.pub`,
            selectors: macos ? MACOS_SELECTORS : undefined,
            labels: {
              "proofbox.os": req.os,
              "proofbox.size": formatSize(size),
              "proofbox.create-token": createToken,
            },
            cidfile,
          })
          .pipe(
            // A failed create can leave a half-made host (a timed-out nsc
            // may have registered it). A limit makes nothing, so skip the
            // sweep there.
            Effect.tapError((error) =>
              error instanceof ProviderLimitError
                ? Effect.void
                : Effect.gen(function* () {
                    const left = yield* nsc
                      .list({ "proofbox.create-token": createToken })
                      .pipe(Effect.orElseSucceed(() => []));
                    yield* Effect.forEach(
                      left,
                      (instance) =>
                        nsc
                          .destroy(instance.clusterId)
                          .pipe(Effect.orElseSucceed(() => undefined)),
                      { discard: true },
                    );
                  }),
            ),
          );
        hostId = id;
        if (maxLifeSeconds <= Math.floor(Date.now() / 1000)) {
          return yield* fail(
            "making the host took the whole Max life; try a larger --max-life",
          );
        }
        const hostPaths = yield* paths(id);
        yield* Effect.tryPromise({
          try: async () => {
            await rename(keyBase, hostPaths.key);
            await rename(`${keyBase}.pub`, `${hostPaths.key}.pub`);
            await writeFile(hostPaths.maxLife, String(maxLifeSeconds), {
              mode: 0o600,
            });
            await writeFile(hostPaths.os, req.os, { mode: 0o600 });
          },
          catch: (cause) =>
            fail(`could not store the host key: ${describe(cause)}`),
        });
        // The host's own Deadline starts when nsc finishes creating it, so
        // it can sit later than the Max life; a detached process destroys
        // the host at the absolute Max life.
        yield* deps.spawnDetached("namespace", "namespace/expire-main", [
          id,
          String(maxLifeSeconds),
        ]);
        // Provisioning can outlast the create duration (a cold image build):
        // keep the host's own Deadline ahead until the Sandbox takes over,
        // but never past the Max life.
        yield* Effect.forkScoped(
          Effect.repeat(
            Effect.gen(function* () {
              const left = maxLifeSeconds - Math.floor(Date.now() / 1000);
              if (left > 0) {
                yield* nsc
                  .extend(id, Math.min(durationSeconds, left))
                  .pipe(Effect.ignore);
              }
            }),
            Schedule.spaced(Duration.seconds(15)),
          ),
        );
        const link = yield* deps.openLink(id, hostPaths, "cli");
        if (macos) {
          return yield* prepareMac(link, {
            id,
            idle: req.idle,
            maxLifeAt: new Date(maxLifeSeconds * 1000),
            size,
          });
        }
        const registry = yield* readTenant(link);
        const version = yield* baseImageVersion(
          BASE_IMAGE_DIR,
          LINUX_TOOL_BUNDLE,
        );
        const snapshotImage =
          req.snapshot === undefined
            ? undefined
            : yield* pullStart(link, registry, req.snapshot, progress);
        const inner = makeDockerProvider({
          client: deps.dockerFor(link),
          imageTag:
            snapshotImage ?? `nscr.io/${registry}/${baseImageTag(version)}`,
          registry: true,
          memoryReserveGb: MEMORY_RESERVE_GB,
          // Publish the VNC port for the Live view; the host has only a
          // private address, and nsc forwards onto that address, so the
          // publish must cover it — loopback binds are unreachable.
          runArgs: [
            "-p",
            "5900:5900",
            ...(snapshotImage === undefined
              ? []
              : ["--label", `proofbox.snapshot=${req.snapshot}`]),
          ],
          brand: brandFor(id),
        });
        const info = yield* inner.create({
          ...req,
          size,
          name: id.slice(0, 6),
          maxLifeAt: new Date(maxLifeSeconds * 1000),
        });
        // The Base image must hide the host's workload token from user code:
        // neither the token file nor the link-local token service may answer.
        const docker = deps.dockerFor(link);
        const container = containerOf(id);
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
                id: `ns:${id}`,
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
                id: `ns:${id}`,
                what: "the token service",
              });
            }
          }),
        );
        return new SandboxInfo({
          name: id,
          os: info.os,
          createdAt: info.createdAt,
          idleSeconds: info.idleSeconds,
          deadline: info.deadline,
          maxLifeAt: info.maxLifeAt,
          base: info.base,
          snapshot: info.snapshot,
          size: info.size,
        });
      }).pipe(
        // A host that vanishes mid-create is a Provider error, not a gone
        // Sandbox — the id was never handed out.
        Effect.catchTag("SandboxGoneError", (error) =>
          Effect.fail(fail(error.message)),
        ),
        Effect.onError(() => Effect.ignoreLogged(cleanup)),
      );
    }).pipe(Effect.scoped);

  const connect = (name: string) =>
    Effect.gen(function* () {
      const link = yield* openLink(name, "keeper");
      if ((yield* osOf(name)) === "macos") {
        yield* readMac(link, name);
        return { exec: macExec(link) };
      }
      yield* getWith(link, name);
      const docker = deps.dockerFor(link);
      const container = containerOf(name);
      return {
        exec: (
          argv: ReadonlyArray<string>,
          options?: Parameters<DockerClient["execStream"]>[2],
        ) => docker.execStream(container, argv, options),
      };
    });

  const memoryKills = (name: string) =>
    Effect.gen(function* () {
      const info = yield* get(name);
      if (info.os === "macos") {
        return 0;
      }
      const read = yield* withCliLink(name, (link) =>
        deps
          .dockerFor(link)
          .execText(containerOf(name), "root", [
            "sh",
            "-c",
            "cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control",
          ]),
      );
      const match = /^oom_kill (\d+)$/m.exec(read.stdout);
      return match === null ? 0 : Number(match[1]);
    });

  const liveView = (name: string) =>
    Effect.gen(function* () {
      if ((yield* osOf(name)) === "macos") {
        return yield* fail("the Live view is not on macOS yet");
      }
      const link = yield* openLink(name, "cli");
      const docker = deps.dockerFor(link);
      const container = containerOf(name);
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
      const forward = yield* nsc.portForward(name, 5900);
      return {
        address: `127.0.0.1:${forward.port}`,
        password,
        gone: forward.gone,
      };
    });

  // The Snapshot holds the container's disk; the Secrets live in a tmpfs,
  // which docker commit leaves out.
  const saveSnapshot = (name: string, fingerprint: string) =>
    Effect.gen(function* () {
      const progress = yield* Progress;
      yield* withCliLink(name, (link) =>
        Effect.gen(function* () {
          const tag = snapshotTag(yield* readTenant(link), fingerprint);
          yield* pushSnapshot(link, containerOf(name), tag);
          yield* keepSnapshot(link, tag, progress);
        }),
      );
    });

  return {
    name: "namespace",
    idPrefix: "ns",
    offers: {
      linux: {
        sizes: LINUX_SIZES,
        features: new Set([
          "desktop",
          "recording",
          "live-view",
          "secrets",
          "snapshot",
        ]),
      },
      macos: { sizes: MACOS_SIZES, features: new Set(["desktop"]) },
    },
    liveView,
    snapshots: {
      baseVersion: baseImageVersion(BASE_IMAGE_DIR, LINUX_TOOL_BUNDLE),
      save: saveSnapshot,
    },
    create,
    get,
    list,
    delete: del,
    extend,
    stateDir: () => "/var/lib/proofbox",
    secretsDir: () => "/run/proofbox/secrets",
    connect,
    memoryKills,
  };
};
