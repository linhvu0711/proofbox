import { execFile } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Clock, Duration, Effect, Schedule } from "effect";
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
import { type Provider, SandboxInfo } from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import { formatSize, type Size } from "../size.ts";
import { TOOL_BUNDLE } from "../tool-bundle.ts";
import type { NscClient } from "./nsc-client.ts";
import type { Link, OpenLink } from "./ssh-link.ts";

const SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 8 },
  { cpu: 8, ramGb: 16 },
  { cpu: 16, ramGb: 32 },
];
const DEFAULT_SIZE: Size = { cpu: 4, ramGb: 8 };

// The host holds Docker itself plus the Sandbox container; keep 1 GB of the
// Namespace size outside the container's limit so the host stays healthy.
const MEMORY_RESERVE_GB = 1;

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
        const link = yield* deps.openLink(name, yield* paths(name), "cli");
        return yield* use(link);
      }),
    );

  const getWith = (link: Link, name: string) =>
    Effect.gen(function* () {
      const container = containerOf(name);
      const result = yield* link.run(
        `docker inspect --format '{{json .Config.Labels}}|{{.State.Running}}' ${container} && docker exec -u root ${container} cat /run/proofbox/deadline`,
      );
      const first = result.stdout.split("\n", 1)[0] ?? "";
      const separator = first.lastIndexOf("|");
      if (separator === -1) {
        if (result.stderr.includes("No such object")) {
          return yield* gone(name);
        }
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

  const get = (name: string) =>
    withCliLink(name, (link) => getWith(link, name));

  const extend = (name: string, deadline: Date) =>
    Effect.gen(function* () {
      const seconds = Math.ceil(
        (deadline.getTime() - (yield* Clock.currentTimeMillis)) / 1000,
      );
      const written = yield* withCliLink(name, (link) =>
        link.run(
          `docker exec -u root ${containerOf(name)} sh -c 'tmp=/run/proofbox/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + $1 ))" > "$tmp" && mv "$tmp" /run/proofbox/deadline' sh ${seconds}`,
        ),
      );
      if (written.exitCode !== 0) {
        if (written.stderr.includes("No such container")) {
          return yield* gone(name);
        }
        return yield* fail(
          `could not write the Deadline: ${written.stderr.trim()}`,
        );
      }
      yield* deps.spawnDetached("namespace", "namespace/extend-main", [
        name,
        String(seconds),
      ]);
    });

  const list = Effect.gen(function* () {
    const instances = yield* nsc.list({ "proofbox.os": "linux" });
    const infos = yield* Effect.forEach(
      instances,
      (instance) =>
        get(instance.clusterId).pipe(
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
      const instances = yield* nsc
        .list({ "proofbox.os": "linux" })
        .pipe(Effect.catchTag("SandboxGoneError", () => Effect.succeed([])));
      if (!instances.some((instance) => instance.clusterId === name)) {
        return "gone" as const;
      }
      yield* nsc
        .destroy(name)
        .pipe(Effect.catchTag("SandboxGoneError", () => Effect.void));
      const dir = yield* paths(name);
      yield* Effect.promise(() =>
        Promise.all([
          rm(dir.key, { force: true }).catch(() => {}),
          rm(`${dir.key}.pub`, { force: true }).catch(() => {}),
        ]).then(() => {}),
      );
      return "deleted" as const;
    });

  const create = (req: {
    readonly os: Parameters<Provider["create"]>[0]["os"];
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
  }) =>
    Effect.gen(function* () {
      yield* nsc.checkLogin.pipe(
        Effect.catchTag("SandboxGoneError", (error) =>
          Effect.fail(fail(error.message)),
        ),
      );
      const size = req.size ?? DEFAULT_SIZE;
      const staged = yield* paths(`new-${process.pid}`);
      const keyBase = join(staged.dir, `ns-new-${process.pid}.key`);
      const cidfile = join(staged.dir, `ns-new-${process.pid}.cid`);
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
            ]).then(() => {}),
          );
          yield* nsc.destroy(hostId).pipe(Effect.orElseSucceed(() => {}));
        }
      });
      return yield* Effect.gen(function* () {
        const progress = yield* Progress;
        const id = yield* nsc
          .create({
            machineType: `linux/amd64:${formatSize(size)}`,
            durationSeconds: Math.min(
              Duration.toSeconds(req.idle) + 60,
              Duration.toSeconds(req.maxLife),
            ),
            sshKeyFile: `${keyBase}.pub`,
            labels: {
              "proofbox.os": "linux",
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
        const hostPaths = yield* paths(id);
        yield* Effect.tryPromise({
          try: async () => {
            await rename(keyBase, hostPaths.key);
            await rename(`${keyBase}.pub`, `${hostPaths.key}.pub`);
          },
          catch: (cause) =>
            fail(`could not store the host key: ${describe(cause)}`),
        });
        const link = yield* deps.openLink(id, hostPaths, "cli");
        const tenant = yield* link.run(
          `sed -n 's/.*"tenant_id": *"tenant_\\([a-z0-9]*\\)".*/\\1/p' /var/run/nsc/metadata.json`,
        );
        const registry = tenant.stdout.trim();
        if (tenant.exitCode !== 0 || registry === "") {
          return yield* fail("could not read the Namespace tenant on the host");
        }
        const version = yield* baseImageVersion(BASE_IMAGE_DIR, TOOL_BUNDLE);
        const inner = makeDockerProvider({
          client: deps.dockerFor(link),
          imageTag: `nscr.io/${registry}/${baseImageTag(version)}`,
          registry: true,
          memoryReserveGb: MEMORY_RESERVE_GB,
          // Publish the VNC port for the Live view; the host reaches it
          // only through our own port-forward, never ingress.
          runArgs: ["-p", "5900:5900"],
          brand: brandFor(id),
        });
        const info = yield* inner.create({
          ...req,
          size,
          name: id.slice(0, 6),
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
      const link = yield* deps.openLink(name, yield* paths(name), "keeper");
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
      yield* get(name);
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
      const password = makeSandboxName(8);
      const link = yield* deps.openLink(name, yield* paths(name), "cli");
      const docker = deps.dockerFor(link);
      const container = containerOf(name);
      // A live call right after a memory kill can hit a host that is still
      // reclaiming; give x11vnc a few tries before giving up.
      const startX11vnc = docker
        .execText(container, "app", [
          "sh",
          "-c",
          'pkill -x x11vnc; mkdir -p ~/.vnc && x11vnc -storepasswd "$1" ~/.vnc/passwd >/dev/null && { x11vnc -display :99 -rfbauth ~/.vnc/passwd -rfbport 5900 -forever -shared -bg -o /tmp/x11vnc.log || { sleep 1; tail -c 1500 /tmp/x11vnc.log >&2; exit 1; }; }',
          "sh",
          password,
        ])
        .pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            (result) => `x11vnc did not start: ${result.stderr.trim()}`,
          ),
        );
      yield* Effect.retry(
        startX11vnc,
        Schedule.spaced(Duration.seconds(1)).pipe(
          Schedule.upTo(Duration.seconds(10)),
        ),
      ).pipe(
        Effect.mapError((e) =>
          fail(typeof e === "string" ? e : `docker exec failed: ${e.message}`),
        ),
      );
      yield* Effect.addFinalizer(() =>
        docker
          .execText(container, "app", ["pkill", "-x", "x11vnc"])
          .pipe(Effect.ignore),
      );
      const port = yield* nsc.portForward(name, 5900);
      return { address: `127.0.0.1:${port}`, password };
    });

  return {
    name: "namespace",
    idPrefix: "ns",
    capabilities: new Set(["os:linux", "live-view"]),
    sizes: SIZES,
    liveView,
    create,
    get,
    list,
    delete: del,
    extend,
    stateDir: () => "/var/lib/proofbox",
    connect,
    memoryKills,
  };
};
