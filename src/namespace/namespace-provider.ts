import { join } from "node:path";
import { type CommandExecutor, FileSystem } from "@effect/platform";
import { Clock, Effect, Either, Fiber, Option, Ref } from "effect";
import { type ProviderError, ProviderUnavailableError } from "../errors.ts";
import { type KeeperPaths, keeperPaths, runtimeDir } from "../keeper/paths.ts";
import type {
  ListResult,
  Provider,
  ProviderLogin,
  SandboxRef,
  UnfinishedSandbox,
} from "../provider.ts";
import { fileStem } from "../sandbox-id.ts";
import { pushHostLife } from "./host-life.ts";
import type { LinuxHost } from "./linux-host.ts";
import type { ApiError, ApiLoginError, NamespaceApi } from "./namespace-api.ts";
import { makeNamespaceCreate } from "./namespace-create.ts";
import { fail, gone, type NamespaceHost, sandboxId } from "./namespace-host.ts";
import { NAMESPACE_LOGIN_FILES, tenantTokenFor } from "./namespace-login.ts";
import { unreachable } from "./namespace-request.ts";
import { completeLogin, startLogin } from "./namespace-signin.ts";
import { DEFAULT_REGION, KNOWN_REGIONS } from "./regions.ts";
import type { Link, OpenLink, SshForward } from "./ssh-link.ts";

export const makeNamespaceProvider = (deps: {
  readonly api: NamespaceApi;
  readonly executor: CommandExecutor.CommandExecutor;
  readonly login: ProviderLogin;
  readonly openLink: OpenLink;
  readonly forward: SshForward;
  // File access, handed in when the Provider is built.
  readonly fs: FileSystem.FileSystem;
  readonly spawnDetached: (
    provider: string,
    rel: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProviderError>;
  readonly hosts: {
    readonly linux: LinuxHost;
    readonly macos: NamespaceHost;
  };
}): Provider => {
  const api = deps.api;
  const forward = deps.forward;
  const paths = (name: string) =>
    keeperPaths({ provider: "ns", name }).pipe(
      Effect.provideService(FileSystem.FileSystem, deps.fs),
    );
  const refPaths = (ref: SandboxRef) => paths(fileStem(ref));
  // The one place an OS picks its host. Hosts made before the OS label
  // existed are Linux.
  const hostFor = (os: string | undefined) =>
    os === "macos" ? deps.hosts.macos : deps.hosts.linux;
  // Local files avoid an API call; other machines use the host's label.
  const hostOf = Effect.fn("NamespaceProvider.hostOf")(function* (
    ref: SandboxRef,
  ) {
    const file = (yield* refPaths(ref)).os;
    const text = yield* deps.fs
      .readFileString(file)
      .pipe(
        Effect.catchAll((error) =>
          Effect.succeed(
            error._tag === "SystemError" && error.reason === "NotFound"
              ? undefined
              : "linux",
          ),
        ),
      );
    if (text !== undefined) {
      return hostFor(text.trim());
    }
    const hosts = yield* api.list(ref.region ?? DEFAULT_REGION, []);
    const label = hosts.find((host) => host.id === ref.name)?.labels[
      "proofbox.os"
    ];
    return hostFor(label);
  });

  // Only the machine that made the Sandbox pinned its sshd host key (ADR
  // 0024).
  const reachSshd = Effect.fn("NamespaceProvider.reachSshd")(function* (
    ref: SandboxRef,
    paths: KeeperPaths,
  ) {
    const pinned = yield* deps.fs
      .exists(paths.sshdKnownHosts)
      .pipe(Effect.orElseSucceed(() => false));
    if (!pinned) {
      return yield* new ProviderUnavailableError({
        provider: "namespace",
        reason: `Sandbox ${sandboxId(ref)} was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ${sandboxId(ref)}`,
      });
    }
  });

  // Link bring-up can outlast a short host Deadline, so every open first
  // bumps the host's own lifetime: detached for a CLI link, a fiber of the
  // Keeper for its own.
  const openLink = Effect.fn("NamespaceProvider.openLink")(function* (
    ref: SandboxRef,
    owner: "cli" | "keeper",
    knownHost?: NamespaceHost,
  ) {
    const host = knownHost ?? (yield* hostOf(ref));
    const hostPaths = yield* refPaths(ref);
    yield* reachSshd(ref, hostPaths);
    if (owner === "keeper") {
      yield* Effect.forkScoped(
        pushHostLife(api, ref, 120).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fs),
        ),
      );
    } else {
      yield* deps.spawnDetached("namespace", "namespace/extend-main", [
        ref.region ?? "",
        ref.name,
        "120",
      ]);
    }
    return yield* deps.openLink(ref, hostPaths, owner, {
      to: "sshd",
      user: host.sshdUser,
    });
  });

  // Every `run` or Docker call needs the ssh link; open a cli-owned one per
  // call so the Keeper's ControlMaster path stays the Keeper's alone.
  const withCliLink = <A, E, R>(
    ref: SandboxRef,
    use: (link: Link) => Effect.Effect<A, E, R>,
    host?: NamespaceHost,
  ): Effect.Effect<A, ApiLoginError | ApiError | E, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = yield* openLink(ref, "cli", host);
        return yield* use(link);
      }),
    );

  const getAs = (host: NamespaceHost, ref: SandboxRef) =>
    withCliLink(ref, (link) => host.read(link, ref), host);

  const get = Effect.fn("NamespaceProvider.get")(function* (ref: SandboxRef) {
    return yield* getAs(yield* hostOf(ref), ref);
  });

  // The local record of the Deadline, which the detached host-expiry reads.
  const recordDeadline = (file: string, deadline: Date) =>
    deps.fs
      .writeFileString(file, String(Math.ceil(deadline.getTime() / 1000)), {
        mode: 0o600,
      })
      .pipe(Effect.ignore);

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
    const host = yield* hostOf(ref);
    const written = yield* withCliLink(
      ref,
      (link) => host.writeDeadline(link, ref, seconds),
      host,
    );
    yield* checkWritten(ref, written);
  });

  // Each OS is its own label, so a host is listed with the OS it runs.
  const listHostsFor = Effect.fn("NamespaceProvider.listHostsFor")(function* (
    region: string,
  ) {
    const listed = yield* Effect.forEach(
      [deps.hosts.linux, deps.hosts.macos],
      (host) =>
        api
          .list(region, [{ name: "proofbox.os", value: host.os }])
          .pipe(
            Effect.map((instances) =>
              instances.map((instance) => ({ host, region, instance })),
            ),
          ),
      { concurrency: 2 },
    );
    return listed.flat();
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
        host: NamespaceHost;
        region: string;
        instance: (typeof hosts)[number]["instance"];
      }
    >();
    for (const host of hosts) {
      if (!byId.has(host.instance.id)) {
        byId.set(host.instance.id, {
          host: host.host,
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
    const dir = yield* runtimeDir("ns").pipe(
      Effect.provideService(FileSystem.FileSystem, deps.fs),
    );
    const entries = yield* deps.fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => []));
    // Only files at least ten minutes old are pruned: an ns-new-* staging
    // key belongs to a create in flight, and a host registered moments ago
    // can still be ahead of the ListInstances answer.
    const stale = (file: string) =>
      deps.fs.stat(join(dir, file)).pipe(
        Effect.map(
          (info) =>
            Option.isSome(info.mtime) &&
            Date.now() - info.mtime.value.getTime() > 600_000,
        ),
        Effect.orElseSucceed(() => false),
      );
    yield* Effect.forEach(
      entries
        .map((entry) => /^ns-(.+)\.key$/.exec(entry)?.[1])
        .filter(
          (name): name is string =>
            name !== undefined && !name.startsWith("new-"),
        )
        .filter((name) => !alive.has(name)),
      (name) =>
        Effect.gen(function* () {
          if (!(yield* stale(`ns-${name}.key`))) return;
          yield* Effect.forEach(
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
            ],
            (suffix) =>
              deps.fs
                .remove(join(dir, `ns-${name}${suffix}`), { force: true })
                .pipe(Effect.ignore),
            { concurrency: "unbounded" },
          );
        }),
      { concurrency: "unbounded" },
    );
    // A host Namespace still makes has no link to read over yet, and one
    // whose Sandbox state was never written reads as never made: both are
    // Unfinished Sandboxes. Any other gone host is dropped.
    const unfinished: Array<UnfinishedSandbox> = [];
    const infos = yield* Effect.forEach(
      live,
      ({ host, region, instance }) =>
        Effect.gen(function* () {
          const entry = {
            name: instance.id,
            region,
            os: host.os,
            createdAt: instance.createdAt,
          };
          if (instance.starting === true) {
            unfinished.push(entry);
            return undefined;
          }
          const ref = { name: instance.id, region };
          const reached = yield* reachSshd(ref, yield* refPaths(ref)).pipe(
            Effect.either,
          );
          if (Either.isLeft(reached)) {
            unreached.push({
              where: `Namespace region ${region}`,
              reason: reached.left.message,
            });
            return undefined;
          }
          return yield* getAs(host, ref).pipe(
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
    yield* Effect.all(
      [
        deps.fs.remove(dir.key, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(`${dir.key}.pub`, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(dir.maxLife, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(dir.deadline, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(dir.os, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(dir.knownHosts, { force: true }).pipe(Effect.ignore),
        deps.fs.remove(dir.sshdKnownHosts, { force: true }).pipe(Effect.ignore),
        deps.fs
          .remove(`${dir.control.replace(/\.ctl$/, "")}.sshkey`, {
            force: true,
          })
          .pipe(Effect.ignore),
        deps.fs
          .remove(`${dir.control.replace(/\.ctl$/, "")}.sshtarget`, {
            force: true,
          })
          .pipe(Effect.ignore),
      ],
      { concurrency: "unbounded" },
    );
    return present ? ("deleted" as const) : ("gone" as const);
  });

  const create = makeNamespaceCreate({
    api,
    executor: deps.executor,
    fs: deps.fs,
    login: deps.login,
    openLink: deps.openLink,
    spawnDetached: deps.spawnDetached,
    hostFor,
  });

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
          pushHostLife(api, ref, seconds).pipe(
            Effect.provideService(FileSystem.FileSystem, deps.fs),
          ),
          scope,
        );
        const last = yield* Ref.getAndSet(lastHostPush, Option.some(pushing));
        if (Option.isSome(last)) {
          yield* Fiber.interruptFork(last.value);
        }
      }
      return seconds;
    });
    const host = yield* hostOf(ref);
    // The gone-watch reads over the Keeper's own link: no new link, and
    // no extend-main, every 2 s.
    const read = host.read(link, ref);
    const info = yield* read;
    return {
      info,
      get: read,
      extend: Effect.fn("NamespaceProvider.connect.extend")(function* (
        deadline: Date,
      ) {
        const seconds = yield* pushHost(deadline);
        yield* checkWritten(ref, yield* host.writeDeadline(link, ref, seconds));
      }),
      // One call over the link per command: the command run's script
      // pushes the Sandbox's Deadline and counts kills around it (ADR
      // 0015). The host side of each push stays here, as `pushHost`.
      transport: {
        shell: host.checks,
        call: host.call(link, ref),
        gone: () => gone(ref),
        fail: (reason: string) => fail(reason),
        pushHost: (deadline: Date) => Effect.asVoid(pushHost(deadline)),
      },
    };
  });

  const liveView = Effect.fn("NamespaceProvider.liveView")(function* (
    ref: SandboxRef,
  ) {
    const host = yield* hostOf(ref);
    const link = yield* openLink(ref, "cli", host);
    // Reading the password changes nothing, so a cut-off read is a plain
    // link-lost error the Caller may try again.
    const password = yield* host.livePassword(link, ref).pipe(
      Effect.catchTag("LinkDroppedError", (error) =>
        Effect.fail(
          new ProviderUnavailableError({
            provider: "namespace",
            reason: error.reason,
          }),
        ),
      ),
    );
    const live = yield* forward(ref, 5900);
    return {
      address: `127.0.0.1:${live.port}`,
      password,
      gone: live.gone,
    };
  });

  // Only a Linux host has a container to save.
  const saveSnapshot = Effect.fn("NamespaceProvider.saveSnapshot")(function* (
    ref: SandboxRef,
    fingerprint: string,
  ) {
    yield* withCliLink(ref, (link) =>
      deps.hosts.linux.saveSnapshot(link, ref, fingerprint),
    );
  });

  return {
    name: "namespace",
    idPrefix: "ns",
    loginFiles: [NAMESPACE_LOGIN_FILES],
    login: {
      _tag: "Ways",
      browser: {
        start: startLogin(),
        complete: completeLogin,
        makeToken: (session, request) =>
          tenantTokenFor(session).pipe(
            Effect.provideService(FileSystem.FileSystem, deps.fs),
            Effect.flatMap((tenant) => api.makeToken(tenant, request)),
          ),
      },
      checkToken: api.checkToken,
    },
    regions: { known: KNOWN_REGIONS, fallback: DEFAULT_REGION },
    offers: {
      linux: deps.hosts.linux.offer,
      macos: deps.hosts.macos.offer,
    },
    liveView,
    snapshots: {
      baseVersion: deps.hosts.linux.baseVersion,
      save: saveSnapshot,
    },
    create,
    get,
    list,
    delete: del,
    extend,
    sandboxFolders: (_name, os) => hostFor(os).folders,
    connect,
  };
};
