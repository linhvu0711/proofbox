import { execFile } from "node:child_process";
import {
  access,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  Cause,
  Chunk,
  Clock,
  Config,
  Duration,
  Effect,
  Either,
  Fiber,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { checksArgv, checksScript, splitChecks } from "../command-checks.ts";
import { parseSpan, pushedDeadline } from "../deadline.ts";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
} from "../docker/base-image.ts";
import type { DockerClient } from "../docker/docker-client.ts";
import {
  LINUX_SCRIPT,
  makeDockerProvider,
  sandboxInfoFromLabels,
} from "../docker/docker-provider.ts";
import {
  MacPrepareError,
  ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenExposedError,
  UnknownRegionError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import {
  type ExecOptions,
  type ListResult,
  type Os,
  type Provider,
  type ProviderLogin,
  SandboxInfo,
  type SandboxRef,
  type UnfinishedSandbox,
} from "../provider.ts";
import { fileStem, formatSandboxId, makeSandboxName } from "../sandbox-id.ts";
import { shellJoin } from "../shell.ts";
import { formatSize, type Size } from "../size.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import { pushHostLife } from "./host-life.ts";
import {
  MAC_SECRETS_DIR,
  macChecks,
  prepareMac,
  readMac,
  turnOnSshd,
  writeMacDeadline,
} from "./mac-host.ts";
import type { ApiError, ApiLoginError, NamespaceApi } from "./namespace-api.ts";
import { unreachable } from "./namespace-api.ts";
import { tenantTokenFor } from "./namespace-login.ts";
import { completeLogin, startLogin } from "./namespace-signin.ts";
import { DEFAULT_REGION, KNOWN_REGIONS } from "./regions.ts";
import { registryRefs } from "./registry-refs.ts";
import {
  pullSnapshot,
  pushSnapshot,
  snapshotRef,
  snapshotTag,
} from "./snapshot-image.ts";
import type { Link, OpenLink, SshForward } from "./ssh-link.ts";

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

// Each push and each use keeps a Base image version or a Snapshot at
// least two weeks; one that is not used for that long expires from the
// registry.
const IMAGE_KEEP_HOURS = 336;

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const exec = promisify(execFile);

const MAC_SCRIPT = checksScript(macChecks());

// Left on a Linux host once its Sandbox is made. Docker removes the
// container at its Deadline (`--rm`) while the host lives on a while, so
// with no container this tells an expired Sandbox from one create never
// finished. The login's home: the host user may not own /var/lib.
const MADE_MARK = '"$HOME/.proofbox-made"';

export const makeNamespaceProvider = (deps: {
  readonly api: NamespaceApi;
  readonly login: ProviderLogin;
  readonly openLink: OpenLink;
  readonly forward: SshForward;
  readonly dockerFor: (link: Link) => DockerClient;
  readonly spawnDetached: (
    provider: string,
    rel: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProviderError>;
}): Provider => {
  const api = deps.api;
  const forward = deps.forward;
  const fail = (reason: string) =>
    new ProviderError({ provider: "namespace", reason });
  const sandboxId = (ref: SandboxRef) =>
    formatSandboxId({ provider: "ns", region: ref.region, name: ref.name });
  // `unfinished`: the host is there, but create never made its Sandbox.
  const gone = (ref: SandboxRef, unfinished?: true) =>
    new SandboxGoneError({ id: sandboxId(ref), unfinished });
  const madeElsewhere = (ref: SandboxRef) =>
    new ProviderUnavailableError({
      provider: "namespace",
      reason: `Sandbox ${sandboxId(ref)} was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ${sandboxId(ref)}`,
    });
  const brandFor = (ref: SandboxRef) => ({
    provider: "namespace",
    id: () => sandboxId(ref),
  });
  const paths = (name: string) => keeperPaths({ provider: "ns", name });
  const refPaths = (ref: SandboxRef) => paths(fileStem(ref));
  // The container takes the first six characters of the instance id.
  const containerOf = (ref: SandboxRef) => `proofbox-${ref.name.slice(0, 6)}`;
  // Local files avoid an API call; other machines use the host's label.
  // Hosts made before the OS label existed are Linux.
  const osOf = Effect.fn("NamespaceProvider.osOf")(function* (ref: SandboxRef) {
    const file = (yield* refPaths(ref)).os;
    const text = yield* Effect.promise(() =>
      readFile(file, "utf8").catch((cause: unknown) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? undefined
          : "linux",
      ),
    );
    if (text !== undefined) {
      return (text.trim() === "macos" ? "macos" : "linux") satisfies Os;
    }
    const hosts = yield* api.list(ref.region ?? DEFAULT_REGION, []);
    const label = hosts.find((host) => host.id === ref.name)?.labels[
      "proofbox.os"
    ];
    return (label === "macos" ? "macos" : "linux") satisfies Os;
  });

  // Link bring-up can outlast a short host Deadline, so every open first
  // bumps the host's own lifetime: detached for a CLI link, a fiber of the
  // Keeper for its own.
  const openLink = Effect.fn("NamespaceProvider.openLink")(function* (
    ref: SandboxRef,
    owner: "cli" | "keeper",
    knownOs?: Os,
  ) {
    const os = knownOs ?? (yield* osOf(ref));
    const hostPaths = yield* refPaths(ref);
    if (
      os === "macos" &&
      !(yield* Effect.promise(() =>
        access(hostPaths.sshdKnownHosts)
          .then(() => true)
          .catch(() => false),
      ))
    ) {
      return yield* madeElsewhere(ref);
    }
    if (owner === "keeper") {
      yield* Effect.forkScoped(pushHostLife(api, ref, 120));
    } else {
      yield* deps.spawnDetached("namespace", "namespace/extend-main", [
        ref.region ?? "",
        ref.name,
        "120",
      ]);
    }
    return yield* deps.openLink(
      ref,
      hostPaths,
      owner,
      os === "macos" ? "sshd" : "gateway",
    );
  });

  // Every `run` or Docker call needs the ssh link; open a cli-owned one per
  // call so the Keeper's ControlMaster path stays the Keeper's alone.
  const withCliLink = <A, E>(
    ref: SandboxRef,
    use: (link: Link) => Effect.Effect<A, E>,
    os?: Os,
  ): Effect.Effect<A, ApiLoginError | ApiError | E> =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = yield* openLink(ref, "cli", os);
        return yield* use(link);
      }),
    );

  const readTenant = Effect.fn("NamespaceProvider.readTenant")(function* (
    link: Link,
  ) {
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
      Effect.flatMap((ref) => api.ensureImageExpiry(ref, IMAGE_KEEP_HOURS)),
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
              (ref) => api.ensureImageExpiry(ref, IMAGE_KEEP_HOURS),
              { discard: true },
            ).pipe(Effect.mapError((errors) => errors[0])),
      ),
      Effect.catchAll((error) =>
        progress.warn(`could not set the Base image expiry (${error.message})`),
      ),
    );

  // The Snapshot's image tag, pulled onto the host; undefined when the
  // Sandbox must start from the Base image instead.
  const pullStart = Effect.fn("NamespaceProvider.pullStart")(function* (
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

  const getWith = Effect.fn("NamespaceProvider.getWith")(function* (
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

  const getAs = (os: Os, ref: SandboxRef) =>
    withCliLink(
      ref,
      (link) => (os === "macos" ? readMac(link, ref) : getWith(link, ref)),
      os,
    );

  const get = Effect.fn("NamespaceProvider.get")(function* (ref: SandboxRef) {
    return yield* getAs(yield* osOf(ref), ref);
  });

  // The local record of the Deadline, which the detached host-expiry reads.
  const recordDeadline = (file: string, deadline: Date) =>
    Effect.promise(() =>
      writeFile(file, String(Math.ceil(deadline.getTime() / 1000)), {
        mode: 0o600,
      }).catch(() => {}),
    );

  // The container's Deadline file, `seconds` from the host's own clock.
  const writeLinuxDeadline = (link: Link, ref: SandboxRef, seconds: number) =>
    link.run(
      `docker exec -u root ${containerOf(ref)} sh -c 'tmp=/run/proofbox/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + $1 ))" > "$tmp" && mv "$tmp" /run/proofbox/deadline' sh ${seconds}`,
    );

  const checkWritten = (
    ref: SandboxRef,
    written: { readonly exitCode: number; readonly stderr: string },
  ) =>
    written.exitCode === 0
      ? Effect.void
      : written.stderr.toLowerCase().includes("no such container")
        ? Effect.fail(gone(ref))
        : Effect.fail(
            fail(`could not write the Deadline: ${written.stderr.trim()}`),
          );

  const extend = Effect.fn("NamespaceProvider.extend")(function* (
    ref: SandboxRef,
    deadline: Date,
  ) {
    const seconds = Math.ceil(
      (deadline.getTime() - (yield* Clock.currentTimeMillis)) / 1000,
    );
    // The detached host-expiry destroys the host at this instant: the
    // record lands before the push so a link that is slow or dead cannot
    // leave the host living past the Sandbox's Deadline.
    yield* recordDeadline((yield* refPaths(ref)).deadline, deadline);
    // The host side first and detached: the API call needs no link, and the
    // link write below can spend a while in bring-up.
    yield* deps.spawnDetached("namespace", "namespace/extend-main", [
      ref.region ?? "",
      ref.name,
      String(seconds),
    ]);
    const os = yield* osOf(ref);
    const written = yield* withCliLink(ref, (link) =>
      os === "macos"
        ? writeMacDeadline(link, seconds)
        : writeLinuxDeadline(link, ref, seconds),
    );
    yield* checkWritten(ref, written);
  });

  // Each OS is its own label, so a host is listed with the OS it runs.
  const listHostsFor = Effect.fn("NamespaceProvider.listHostsFor")(function* (
    region: string,
  ) {
    const [linux, macos] = yield* Effect.all(
      [
        api.list(region, [{ name: "proofbox.os", value: "linux" }]),
        api.list(region, [{ name: "proofbox.os", value: "macos" }]),
      ],
      { concurrency: 2 },
    );
    return [
      ...linux.map((instance) => ({
        os: "linux" as const,
        region,
        instance,
      })),
      ...macos.map((instance) => ({
        os: "macos" as const,
        region,
        instance,
      })),
    ];
  });

  const list = Effect.gen(function* () {
    // Each region's list is global today, so one answer would do. `list`
    // still asks every known region: a second one is a spare when a
    // region is down, and it keeps the list whole if a region ever lists
    // only its own hosts.
    // A region that cannot be reached is named in `unreached`; when
    // nothing answered at all the list fails with the first error.
    const perRegion = yield* Effect.forEach(
      KNOWN_REGIONS,
      (region) => listHostsFor(region).pipe(Effect.either),
      { concurrency: 2 },
    );
    const unreached: Array<{ where: string; reason: string }> = [];
    const failures: Array<ApiError | ApiLoginError> = [];
    const hosts = perRegion.flatMap((entry, index) => {
      if (Either.isLeft(entry)) {
        failures.push(entry.left);
        unreached.push({
          where: `Namespace region ${KNOWN_REGIONS[index] ?? ""}`,
          reason: entry.left.message,
        });
        return [];
      }
      return entry.right;
    });
    if (failures.length === KNOWN_REGIONS.length) {
      const first = failures[0];
      return yield* first ?? fail("no Namespace region could be reached");
    }
    // Every endpoint's list is global: one host comes back once per
    // region asked. Keep one entry per instance, named by the region it
    // was made in — the `proofbox.region` label create stamps — or the
    // continent the instance reports, or the queried region.
    const byId = new Map<
      string,
      {
        os: "linux" | "macos";
        region: string;
        instance: (typeof hosts)[number]["instance"];
      }
    >();
    for (const host of hosts) {
      if (!byId.has(host.instance.id)) {
        byId.set(host.instance.id, {
          os: host.os,
          region:
            host.instance.labels["proofbox.region"] ??
            host.instance.region ??
            host.region,
          instance: host.instance,
        });
      }
    }
    const live = [...byId.values()];
    // Hosts can expire without a delete; their keypair and Max-life cap
    // stay in the runtime dir, so drop the files of any host that is gone.
    const alive = new Set(
      live.map((host) =>
        fileStem({ name: host.instance.id, region: host.region }),
      ),
    );
    const dir = (yield* paths("__probe__")).dir;
    yield* Effect.promise(async () => {
      const entries = await readdir(dir).catch(() => [] as string[]);
      // Only files at least ten minutes old are pruned: an ns-new-* staging
      // key belongs to a create in flight, and a host registered moments ago
      // can still be ahead of the ListInstances answer.
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
              [
                ".key",
                ".key.pub",
                ".max-life",
                ".deadline",
                ".os",
                ".ctl",
                ".sock",
                ".sshkey",
                ".sshtarget",
                ".known-hosts",
                ".sshd-known-hosts",
              ].map((suffix) =>
                rm(join(dir, `ns-${name}${suffix}`), { force: true }).catch(
                  () => {},
                ),
              ),
            );
          }),
      ).then(() => {});
    });
    // A host Namespace still makes has no link to read over yet, and one
    // whose Sandbox state was never written reads as never made: both are
    // Unfinished Sandboxes. Any other gone host is dropped.
    const unfinished: Array<UnfinishedSandbox> = [];
    const infos = yield* Effect.forEach(
      live,
      ({ os, region, instance }) =>
        Effect.gen(function* () {
          const entry = {
            name: instance.id,
            region,
            os,
            createdAt: instance.createdAt,
          };
          if (instance.starting === true) {
            unfinished.push(entry);
            return undefined;
          }
          const ref = { name: instance.id, region };
          if (os === "macos") {
            const hostPaths = yield* refPaths(ref);
            const pinned = yield* Effect.promise(() =>
              access(hostPaths.sshdKnownHosts)
                .then(() => true)
                .catch(() => false),
            );
            if (!pinned) {
              unreached.push({
                where: `Namespace region ${region}`,
                reason: madeElsewhere(ref).message,
              });
              return undefined;
            }
          }
          return yield* getAs(os, ref).pipe(
            Effect.catchTag("SandboxGoneError", (error) =>
              Effect.sync(() => {
                if (error.unfinished === true) {
                  unfinished.push(entry);
                }
                return undefined;
              }),
            ),
          );
        }),
      { discard: false },
    );
    return {
      infos: infos.filter((info) => info !== undefined),
      unreached,
      unfinished,
    } satisfies ListResult;
  }).pipe(
    Effect.catchTag("SandboxGoneError", () => Effect.fail(unreachable())),
    Effect.catchTag("NotLoggedInError", () =>
      Effect.succeed({
        infos: [],
        unreached: [],
        unfinished: [],
      } satisfies ListResult),
    ),
  );

  const del = Effect.fn("NamespaceProvider.del")(function* (ref: SandboxRef) {
    const region = ref.region ?? "";
    const instanceId = ref.name;
    const hosts = yield* listHostsFor(region).pipe(
      Effect.catchTag("SandboxGoneError", () => Effect.succeed([])),
    );
    const present = hosts.some((host) => host.instance.id === instanceId);
    if (present) {
      yield* api
        .destroy(region, instanceId)
        .pipe(Effect.catchTag("SandboxGoneError", () => Effect.void));
    }
    // Hosts that expire on their own never reach destroy, so the local
    // keypair and Max-life cap are removed whether or not the host is
    // still listed.
    const dir = yield* refPaths(ref);
    yield* Effect.promise(() =>
      Promise.all([
        rm(dir.key, { force: true }).catch(() => {}),
        rm(`${dir.key}.pub`, { force: true }).catch(() => {}),
        rm(dir.maxLife, { force: true }).catch(() => {}),
        rm(dir.deadline, { force: true }).catch(() => {}),
        rm(dir.os, { force: true }).catch(() => {}),
        rm(dir.knownHosts, { force: true }).catch(() => {}),
        rm(dir.sshdKnownHosts, { force: true }).catch(() => {}),
        rm(`${dir.control.replace(/\.ctl$/, "")}.sshkey`, {
          force: true,
        }).catch(() => {}),
        rm(`${dir.control.replace(/\.ctl$/, "")}.sshtarget`, {
          force: true,
        }).catch(() => {}),
      ]).then(() => {}),
    );
    return present ? ("deleted" as const) : ("gone" as const);
  });

  // create+wait can hang; bound the wait, then sweep whatever it
  // half-made.
  const createTimeout = Config.string("PROOFBOX_NS_CREATE_TIMEOUT").pipe(
    Config.withDefault("60s"),
  );

  // A destroy frees the host's quota a moment after it returns, so a
  // create right behind a delete can land on a full-looking account:
  // give a plan-limit refusal this long to lift before reporting it.
  const limitWait = Config.string("PROOFBOX_NS_LIMIT_WAIT").pipe(
    Config.withDefault("45s"),
  );

  const create = Effect.fn("NamespaceProvider.create")(function* (req: {
    readonly os: Parameters<Provider["create"]>[0]["os"];
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
    readonly snapshot?: string | undefined;
  }) {
    const login = yield* deps.login;
    const region = Option.getOrElse(login.region, () => DEFAULT_REGION);
    if (!KNOWN_REGIONS.includes(region)) {
      return yield* new UnknownRegionError({
        provider: "namespace",
        region,
        known: KNOWN_REGIONS,
      });
    }
    const macos = req.os === "macos";
    const size = req.size ?? (macos ? DEFAULT_MACOS_SIZE : DEFAULT_SIZE);
    const staged = yield* paths(`new-${process.pid}`);
    const keyBase = join(staged.dir, `ns-new-${process.pid}.key`);
    // Whatever part of the make is left — key files, the host — leaves
    // nothing behind on a failed create.
    const createToken = makeSandboxName();
    let hostRef: SandboxRef | undefined;
    let deadlineAt = 0;
    const cleanup = Effect.gen(function* () {
      yield* Effect.promise(() =>
        Promise.all([
          rm(keyBase, { force: true }).catch(() => {}),
          rm(`${keyBase}.pub`, { force: true }).catch(() => {}),
        ]).then(() => {}),
      );
      if (hostRef !== undefined) {
        const hostPaths = yield* refPaths(hostRef);
        yield* Effect.promise(() =>
          Promise.all([
            rm(hostPaths.key, { force: true }).catch(() => {}),
            rm(`${hostPaths.key}.pub`, { force: true }).catch(() => {}),
            rm(hostPaths.maxLife, { force: true }).catch(() => {}),
            rm(hostPaths.os, { force: true }).catch(() => {}),
            rm(hostPaths.sshdKnownHosts, { force: true }).catch(() => {}),
          ]).then(() => {}),
        );
        yield* api
          .destroy(hostRef.region ?? "", hostRef.name)
          .pipe(Effect.orElseSucceed(() => {}));
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
      const sshKey = (yield* Effect.tryPromise({
        try: () => readFile(`${keyBase}.pub`, "utf8"),
        catch: (cause) =>
          fail(`could not read the host key: ${describe(cause)}`),
      })).trim();
      const spanText = yield* createTimeout.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const span = yield* parseSpan(
        "PROOFBOX_NS_CREATE_TIMEOUT",
        spanText,
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const limitSpan = yield* parseSpan(
        "PROOFBOX_NS_LIMIT_WAIT",
        yield* limitWait.pipe(Effect.mapError((error) => fail(error.message))),
        {
          units: ["ms", "s", "m"],
          zero: true,
          example: "45s",
        },
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const instanceId = yield* Effect.timeoutOption(
        Effect.gen(function* () {
          const nowMillis = yield* Clock.currentTimeMillis;
          deadlineAt = Math.floor((nowMillis + durationSeconds * 1000) / 1000);
          const made = yield* api
            .create(region, {
              shape: {
                os: req.os,
                machineArch: macos ? "arm64" : "amd64",
                virtualCpu: size.cpu,
                memoryMegabytes: size.ramGb * 1024,
                selectors: macos
                  ? Object.entries(MACOS_SELECTORS).map(([name, value]) => ({
                      name,
                      value,
                    }))
                  : [],
              },
              labels: [
                { name: "proofbox.os", value: req.os },
                { name: "proofbox.region", value: region },
                { name: "proofbox.size", value: formatSize(size) },
                { name: "proofbox.create-token", value: createToken },
              ],
              deadline: new Date(nowMillis + durationSeconds * 1000),
              authorizedSshKeys: [sshKey],
            })
            .pipe(
              Effect.retry({
                while: (error) => error instanceof ProviderLimitError,
                schedule: Schedule.spaced(Duration.seconds(5)).pipe(
                  Schedule.upTo(limitSpan),
                ),
              }),
            );
          yield* api.wait(region, made);
          return made;
        }),
        span,
      ).pipe(
        Effect.flatMap((made) =>
          Option.isNone(made)
            ? Effect.fail(
                new ProviderUnavailableError({
                  provider: "namespace",
                  reason: `Namespace did not make the host in ${spanText.replace(/(\d)([a-z])/g, "$1 $2")}; deleted any half-made host. Try again`,
                }),
              )
            : Effect.succeed(made.value),
        ),
        // A failed or interrupted create can leave a half-made host (a
        // timed-out call may have registered it, and Ctrl-C can land
        // before the host id is known). A limit makes nothing, so skip
        // the sweep there. A plain failure already has its one error
        // line; once a Ctrl-C is in the cause there may be none, so a
        // sweep that cannot finish says where to look.
        Effect.onError((cause) =>
          Option.exists(
            Cause.failureOption(cause),
            (error) => error instanceof ProviderLimitError,
          )
            ? Effect.void
            : Effect.gen(function* () {
                const left = yield* api.list(region, [
                  { name: "proofbox.create-token", value: createToken },
                ]);
                yield* Effect.validateAll(
                  left,
                  (instance) =>
                    api
                      .destroy(region, instance.id)
                      .pipe(
                        Effect.catchTag("SandboxGoneError", () => Effect.void),
                      ),
                  { discard: true },
                );
              }).pipe(
                Effect.catchAll(() =>
                  Cause.isInterrupted(cause)
                    ? progress.warn(
                        "could not delete the host this create started; it may be left. Run: proofbox list",
                      )
                    : Effect.void,
                ),
              ),
        ),
      );
      const ref: SandboxRef = { name: instanceId, region };
      hostRef = ref;
      if (maxLifeSeconds <= Math.floor(Date.now() / 1000)) {
        return yield* fail(
          "making the host took the whole Max life; try a larger --max-life",
        );
      }
      const hostPaths = yield* refPaths(ref);
      yield* Effect.tryPromise({
        try: async () => {
          await rename(keyBase, hostPaths.key);
          await rename(`${keyBase}.pub`, `${hostPaths.key}.pub`);
          await writeFile(hostPaths.maxLife, String(maxLifeSeconds), {
            mode: 0o600,
          });
          await writeFile(hostPaths.deadline, String(deadlineAt), {
            mode: 0o600,
          });
          await writeFile(hostPaths.os, req.os, { mode: 0o600 });
        },
        catch: (cause) =>
          fail(`could not store the host key: ${describe(cause)}`),
      });
      // The host's own Deadline starts when Namespace finishes creating it, so
      // it can sit later than the Max life; a detached process destroys
      // the host at the absolute Max life.
      yield* deps.spawnDetached("namespace", "namespace/expire-main", [
        region,
        instanceId,
        String(maxLifeSeconds),
      ]);
      // Provisioning can outlast the create duration (a cold image build):
      // keep the host's own Deadline ahead until the Sandbox takes over,
      // but never past the Max life. The recorded Deadline moves with it —
      // otherwise the host-expiry destroys a host that is still being
      // prepared once its initial allowance runs out.
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.gen(function* () {
            const left = maxLifeSeconds - Math.floor(Date.now() / 1000);
            if (left > 0) {
              const pushedAt =
                Math.floor(Date.now() / 1000) + Math.min(durationSeconds, left);
              yield* Effect.promise(() =>
                writeFile(hostPaths.deadline, String(pushedAt), {
                  mode: 0o600,
                }).catch(() => {}),
              );
              yield* api
                .extend(region, instanceId, Math.min(durationSeconds, left))
                .pipe(Effect.ignore);
            }
          }),
          Schedule.spaced(Duration.seconds(15)),
        ),
      );
      const link = yield* deps.openLink(ref, hostPaths, "cli", "gateway");
      if (macos) {
        yield* progress.step(
          "turning on sshd",
          turnOnSshd(link, ref, hostPaths),
        );
        const sshd = yield* deps.openLink(ref, hostPaths, "cli", "sshd").pipe(
          Effect.catchTag("ProviderUnavailableError", () =>
            Effect.fail(
              new MacPrepareError({
                id: sandboxId(ref),
                what: "sshd cannot be reached",
              }),
            ),
          ),
        );
        return yield* prepareMac(sshd, {
          ref,
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
        name: instanceId.slice(0, 6),
        maxLifeAt: new Date(maxLifeSeconds * 1000),
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
    }).pipe(
      // A host that vanishes mid-create is a Provider error, not a gone
      // Sandbox — the id was never handed out.
      Effect.catchTag("SandboxGoneError", (error) =>
        Effect.fail(fail(error.message)),
      ),
      Effect.onError(() => Effect.ignoreLogged(cleanup)),
    );
  }, Effect.scoped);

  const connect = Effect.fn("NamespaceProvider.connect")(function* (
    ref: SandboxRef,
  ) {
    const link = yield* openLink(ref, "keeper");
    const deadlineFile = (yield* refPaths(ref)).deadline;
    const scope = yield* Effect.scope;
    const lastHostPush = yield* Ref.make(
      Option.none<Fiber.RuntimeFiber<void>>(),
    );
    // The host side of one Deadline push, from the Keeper: the local
    // record first, as `extend` does, then the host's own lifetime in a
    // fiber of the Keeper that no one waits on. A newer push takes the
    // place of the last one. Gives the seconds from now to `deadline`.
    const pushHost = Effect.fn("NamespaceProvider.pushHost")(function* (
      deadline: Date,
    ) {
      const seconds = Math.ceil(
        (deadline.getTime() - (yield* Clock.currentTimeMillis)) / 1000,
      );
      yield* recordDeadline(deadlineFile, deadline);
      if (seconds > 0) {
        const pushing = yield* Effect.forkIn(
          pushHostLife(api, ref, seconds),
          scope,
        );
        const last = yield* Ref.getAndSet(lastHostPush, Option.some(pushing));
        if (Option.isSome(last)) {
          yield* Fiber.interruptFork(last.value);
        }
      }
      return seconds;
    });
    const mac = (yield* osOf(ref)) === "macos";
    // The gone-watch reads over the Keeper's own link: no new link, and
    // no extend-main, every 2 s.
    const read = mac ? readMac(link, ref) : getWith(link, ref);
    const info = yield* read;
    const script = mac ? MAC_SCRIPT : LINUX_SCRIPT;
    // A Mac runs the script over the link itself; Linux in its container.
    const call = mac
      ? (argv: ReadonlyArray<string>, options?: ExecOptions) =>
          link.stream(shellJoin(argv), options)
      : (() => {
          const docker = deps.dockerFor(link);
          const container = containerOf(ref);
          return (argv: ReadonlyArray<string>, options?: ExecOptions) =>
            docker.execStream(container, argv, options, "root");
        })();
    const pushNow = Effect.flatMap(pushedDeadline(info), pushHost);
    return {
      info,
      get: read,
      extend: Effect.fn("NamespaceProvider.connect.extend")(function* (
        deadline: Date,
      ) {
        const seconds = yield* pushHost(deadline);
        yield* checkWritten(
          ref,
          yield* mac
            ? writeMacDeadline(link, seconds)
            : writeLinuxDeadline(link, ref, seconds),
        );
      }),
      // One call over the link per command: the script pushes the
      // Sandbox's Deadline and counts kills around it (ADR 0015). The
      // host side of each push stays here.
      exec: (argv: ReadonlyArray<string>, options?: ExecOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const nowMillis = yield* Clock.currentTimeMillis;
            yield* pushNow;
            return splitChecks(
              call(checksArgv(script, info, nowMillis, argv), options),
              {
                gone: () => gone(ref),
                pushFailed: (detail) =>
                  fail(`could not write the Deadline: ${detail}`),
              },
            ).pipe(
              Stream.tap((event) =>
                event._tag === "Exit" ? pushNow : Effect.void,
              ),
            );
          }),
        ),
    };
  });

  const liveView = Effect.fn("NamespaceProvider.liveView")(function* (
    ref: SandboxRef,
  ) {
    if ((yield* osOf(ref)) === "macos") {
      const link = yield* openLink(ref, "cli");
      // The candidate goes on stdin, never the command line. As on
      // Linux, a lock serializes live-view starts, the stored password
      // is reused when set — one password per Mac — and each viewer
      // drops a session marker the finalizer counts. The printed line
      // is the settled password. macOS has no flock, so the lock is a
      // mkdir'ed dir that a waiter steals once its pid is gone, or once
      // it has sat over two seconds with no pid at all — a holder that
      // died before writing it.
      const candidate = makeSandboxName(8);
      const events = yield* link
        .stream(
          `sudo -n sh -c ${shellJoin([
            'umask 077; L=/var/db/proofbox-live; mkdir -p "$L"; i=0; while ! mkdir "$L/.lock" 2>/dev/null; do lp=$(cat "$L/.lock/pid" 2>/dev/null); if [ -n "$lp" ]; then if ! kill -0 "$lp" 2>/dev/null; then rm -rf "$L/.lock"; fi; elif [ $(( $(date +%s) - $(stat -f %m "$L/.lock" 2>/dev/null || echo 0) )) -gt 2 ]; then rm -rf "$L/.lock"; fi; i=$((i + 1)); if [ $i -gt 50 ]; then exit 1; fi; sleep 0.2; done; printf "%s\\n" $$ > "$L/.lock/pid"; trap \'rm -rf "$L/.lock"\' EXIT; f=$L/.password; if [ -s "$f" ]; then pw=$(cat "$f"); else IFS= read -r pw || exit 1; K=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart; "$K" -configure -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw "$pw" >/dev/null && defaults write /Library/Preferences/com.apple.RemoteManagement VNCAlwaysStartOnConsole -bool true && "$K" -restart -agent >/dev/null || exit 1; printf "%s\\n" "$pw" > "$f"; fi; touch "$L/$0"; printf "%s" "$pw"',
          ])} ${candidate}`,
          {
            stdin: Stream.make(new TextEncoder().encode(`${candidate}\n`)),
          },
        )
        .pipe(Stream.runCollect);
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
      const password = stdout.trim();
      if (exitCode !== 0 || password === "") {
        return yield* fail(
          `the Live view could not set the VNC password: ${stderr.trim()}`,
        );
      }
      yield* Effect.addFinalizer(() =>
        link
          .run(
            `sudo -n sh -c ${shellJoin([
              'L=/var/db/proofbox-live; i=0; while ! mkdir "$L/.lock" 2>/dev/null; do lp=$(cat "$L/.lock/pid" 2>/dev/null); if [ -n "$lp" ]; then if ! kill -0 "$lp" 2>/dev/null; then rm -rf "$L/.lock"; fi; elif [ $(( $(date +%s) - $(stat -f %m "$L/.lock" 2>/dev/null || echo 0) )) -gt 2 ]; then rm -rf "$L/.lock"; fi; i=$((i + 1)); if [ $i -gt 50 ]; then rm -f "$L/$1"; exit 0; fi; sleep 0.2; done; rm -f "$L/$1"; if [ -z "$(ls -A "$L" 2>/dev/null | grep -vxF .password | grep -vxF .lock)" ]; then rm -f "$L/.password"; /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -deactivate >/dev/null 2>&1; fi; rm -rf "$L/.lock"; true',
              "sh",
              candidate,
            ])}`,
          )
          .pipe(Effect.ignore),
      );
      const live = yield* forward(ref, 5900);
      return {
        address: `127.0.0.1:${live.port}`,
        password,
        gone: live.gone,
      };
    }
    const link = yield* openLink(ref, "cli");
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
    const live = yield* forward(ref, 5900);
    return {
      address: `127.0.0.1:${live.port}`,
      password,
      gone: live.gone,
    };
  });

  // The Snapshot holds the container's disk; the Secrets live in a tmpfs,
  // which docker commit leaves out.
  const saveSnapshot = Effect.fn("NamespaceProvider.saveSnapshot")(function* (
    ref: SandboxRef,
    fingerprint: string,
  ) {
    const progress = yield* Progress;
    yield* withCliLink(ref, (link) =>
      Effect.gen(function* () {
        const tag = snapshotTag(yield* readTenant(link), fingerprint);
        yield* pushSnapshot(link, containerOf(ref), tag);
        yield* keepSnapshot(link, tag, progress);
      }),
    );
  });

  return {
    name: "namespace",
    idPrefix: "ns",
    login: {
      _tag: "Ways",
      browser: {
        start: startLogin(),
        complete: completeLogin,
        makeToken: (session, request) =>
          tenantTokenFor(session).pipe(
            Effect.flatMap((tenant) => api.makeToken(tenant, request)),
          ),
      },
      checkToken: api.checkToken,
    },
    regions: { known: KNOWN_REGIONS, fallback: DEFAULT_REGION },
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
      macos: {
        sizes: MACOS_SIZES,
        features: new Set(["desktop", "recording", "secrets", "live-view"]),
      },
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
    secretsDir: (_name, os) =>
      os === "macos" ? MAC_SECRETS_DIR : "/run/proofbox/secrets",
    connect,
  };
};
