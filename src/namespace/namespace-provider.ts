import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Either,
  Fiber,
  Option,
  Ref,
  Schedule,
} from "effect";
import { captureCommand } from "../command-events.ts";
import { parseSpan } from "../deadline.ts";
import {
  type ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  UnknownRegionError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import type {
  ListResult,
  Provider,
  ProviderLogin,
  SandboxRef,
  UnfinishedSandbox,
} from "../provider.ts";
import { fileStem, makeSandboxName } from "../sandbox-id.ts";
import { formatSize, type Size } from "../size.ts";
import { pushHostLife } from "./host-life.ts";
import type { LinuxHost } from "./linux-host.ts";
import { MAC_SECRETS_DIR } from "./mac-host.ts";
import type { ApiError, ApiLoginError, NamespaceApi } from "./namespace-api.ts";
import { unreachable } from "./namespace-api.ts";
import { describe, fail, gone, type NamespaceHost } from "./namespace-host.ts";
import { NAMESPACE_LOGIN_FILES, tenantTokenFor } from "./namespace-login.ts";
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
    const text = yield* Effect.promise(() =>
      readFile(file, "utf8").catch((cause: unknown) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? undefined
          : "linux",
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
    yield* host.reach(ref, hostPaths);
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
    return yield* deps.openLink(ref, hostPaths, owner, host.via);
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
    Effect.promise(() =>
      writeFile(file, String(Math.ceil(deadline.getTime() / 1000)), {
        mode: 0o600,
      }).catch(() => {}),
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
    const dir = (yield* paths("__probe__")).dir;
    yield* Effect.promise(async () => {
      const entries = await readdir(dir).catch((): Array<string> => []);
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
          const reached = yield* host
            .reach(ref, yield* refPaths(ref))
            .pipe(Effect.either);
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
    const host = hostFor(req.os);
    const size = req.size ?? host.defaultSize;
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
      const keygen = yield* captureCommand(
        Command.make(
          "ssh-keygen",
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "proofbox",
          "-f",
          keyBase,
        ),
      ).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, deps.executor),
        Effect.mapError((error) =>
          error._tag === "SystemError" && error.reason === "NotFound"
            ? fail("ssh-keygen failed: spawn ssh-keygen ENOENT")
            : fail(`ssh-keygen failed: ${error.message}`),
        ),
      );
      if (keygen.exitCode !== 0) {
        return yield* fail(
          `ssh-keygen failed: exit ${keygen.exitCode}: ${keygen.stderr.trim()}`,
        );
      }
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
                machineArch: host.machine.arch,
                virtualCpu: size.cpu,
                memoryMegabytes: size.ramGb * 1024,
                selectors: host.machine.selectors,
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
      return yield* host.make(link, {
        req,
        ref,
        paths: hostPaths,
        size,
        maxLifeAt: new Date(maxLifeSeconds * 1000),
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
    const password = yield* host.livePassword(link, ref);
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
    sandboxFolders: (_name, os) => ({
      state: "/var/lib/proofbox",
      secrets: os === "macos" ? MAC_SECRETS_DIR : "/run/proofbox/secrets",
    }),
    connect,
  };
};
