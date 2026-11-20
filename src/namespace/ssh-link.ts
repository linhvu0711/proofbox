import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import {
  Clock,
  Config,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { captureCommand, commandEvents } from "../command-events.ts";
import { parseSpan } from "../deadline.ts";
import {
  causeText,
  LinkDroppedError,
  ProviderError,
  ProviderUnavailableError,
  platformReason,
  type SandboxGoneError,
} from "../errors.ts";
import { writeKeeperLog } from "../keeper/keeper-log.ts";
import { type KeeperPaths, runtimeDir } from "../keeper/paths.ts";
import type { ExecEvent, ExecOptions, SandboxRef } from "../provider.ts";
import { shellJoin } from "../shell.ts";
import type {
  ApiError,
  ApiLoginError,
  NamespaceApi,
  SshConfig,
} from "./namespace-api.ts";
import { gone, sandboxId } from "./namespace-host.ts";

export interface HostResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// A Link is one ssh connection to the host: `ssh` is the argument tail for
// `ssh <...> <command line>` (reusing the ControlMaster when one is up),
// `run` runs a remote shell line over it and collects its text, and
// `stream` runs one with stdin and streams its raw bytes.
export interface Link {
  readonly ssh: ReadonlyArray<string>;
  readonly run: (
    commandLine: string,
  ) => Effect.Effect<
    HostResult,
    ProviderError | ProviderUnavailableError | SandboxGoneError
  >;
  readonly stream: (
    commandLine: string,
    options?: ExecOptions,
  ) => Stream.Stream<
    ExecEvent,
    | ProviderError
    | ProviderUnavailableError
    | SandboxGoneError
    | LinkDroppedError
  >;
}

type LinkUp = Effect.Effect<
  void,
  ProviderError | ProviderUnavailableError | SandboxGoneError
>;

type LinkOwner = "keeper" | "cli";
// Where a link goes: the Namespace gateway itself, or the host's own sshd,
// reached through the gateway, as `user`.
export type LinkRoute =
  | { readonly to: "gateway" }
  | { readonly to: "sshd"; readonly user: string };

export type OpenLink = (
  ref: SandboxRef,
  paths: KeeperPaths,
  owner: LinkOwner,
  route: LinkRoute,
) => Effect.Effect<Link, ApiError | ApiLoginError, Scope.Scope>;

// Verbose ssh writes debug lines past the real error, so the last
// non-debug line is the one that says what failed.
const lastLine = (text: string) => {
  const lines = text.trim().split("\n");
  return (
    lines.filter((line) => !line.startsWith("debug")).pop() ?? lines.pop() ?? ""
  );
};

// A dead SSH gateway gets this long to come back before an exec or a
// connect fails; 0s makes a test's first failure the final answer.
const linkWaitText = Config.string("PROOFBOX_NS_LINK_WAIT").pipe(
  Config.withDefault("120s"),
);

// A stalled link ends after three unanswered probes 10 s apart, 30 to 40
// s in all: well inside the 120 s helper limit (ADR 0019), with room for
// one lost answer. Both the master and the gateway hop carry it, since
// either one can sit on the stalled path. The Live view's forward carries
// it too, so a Live view on a dead link ends instead of hanging.
const KEEP_ALIVE = [
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
] as const;

const linkLost = (ref: SandboxRef, detail: string) =>
  new ProviderUnavailableError({
    provider: "namespace",
    reason: `Could not connect to Sandbox ${sandboxId(ref)} over SSH (${detail}). Try again in a minute.`,
  });

// A host key that does not match what GetSSHConfig gave is a wrong or
// recycled host, not a dead link — refuse at once rather than retry.
const hostKeyRefused = (ref: SandboxRef) => {
  const id = sandboxId(ref);
  return new ProviderUnavailableError({
    provider: "namespace",
    reason: `Refused to connect to Sandbox ${id}: its SSH host key does not match the key Namespace gave. Run: proofbox delete ${id}`,
  });
};

// Bring-up failures that mean "the link is not ready yet" — the SSH
// gateway still coming up, a handshake that dropped. Only these are
// retried; a missing ssh binary or not being logged in fails at once.
// After the retries give up it is mapped to the linkLost
// ProviderUnavailableError.
class LinkDownError extends Data.TaggedError("LinkDownError")<{
  readonly detail: string;
}> {}
const down = (detail: string) => new LinkDownError({ detail });

// The gateway hop is the same for the command link and the Live view
// forward, so its setup lives once: the GetSSHConfig answer, its key and
// pinned host keys on disk, and the check that names a dead host gone.
const gatewayConfig = Effect.fn("sshLink.gatewayConfig")(function* (
  api: NamespaceApi,
  ref: SandboxRef,
) {
  const config = yield* api.sshConfig(ref.region ?? "", ref.name).pipe(
    Effect.catchTag("ProviderError", (error) =>
      Effect.fail(
        new ProviderError({
          provider: "namespace",
          reason: `could not get SSH access to Sandbox ${sandboxId(ref)} (${error.reason}); try again in a minute`,
        }),
      ),
    ),
  );
  return { config, gateway: `${config.username}@${config.endpoint}` };
});

// The key is removed when the scope closes; the known_hosts file is the
// caller's, since the Keeper's reopen reads the link's one again later.
const pinGateway = Effect.fn("sshLink.pinGateway")(function* (
  fs: FileSystem.FileSystem,
  config: SshConfig,
  files: { readonly key: string; readonly knownHosts: string },
) {
  yield* fs.writeFile(files.key, config.privateKey, { mode: 0o600 }).pipe(
    Effect.andThen(fs.chmod(files.key, 0o600)),
    Effect.mapError(
      (error) =>
        new ProviderError({
          provider: "namespace",
          reason: platformReason(error),
        }),
    ),
  );
  yield* fs
    .writeFileString(
      files.knownHosts,
      `${config.hostKeys.map((hostKey) => `${config.endpoint} ${hostKey}`).join("\n")}\n`,
      { mode: 0o600 },
    )
    .pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({
            provider: "namespace",
            reason: platformReason(error),
          }),
      ),
    );
  yield* Effect.addFinalizer(() =>
    fs.remove(files.key, { force: true }).pipe(Effect.ignore),
  );
});

// A dead host drops the gateway link just like a cold one does; the list
// names the Sandbox gone instead of the bare ssh failure.
const goneOr = Effect.fn("sshLink.goneOr")(function* <E>(
  api: NamespaceApi,
  ref: SandboxRef,
  error: E,
) {
  const instances = yield* api
    .list(ref.region ?? "", [])
    .pipe(Effect.catchAll(() => Effect.fail(error)));
  return yield* instances.some((instance) => instance.id === ref.name)
    ? Effect.fail(error)
    : Effect.fail(gone(ref));
});

export const makeOpenLink = (
  api: NamespaceApi,
  executor: CommandExecutor.CommandExecutor,
  fs: FileSystem.FileSystem,
  sshBin = "ssh",
): OpenLink => {
  const sshError = (error: {
    readonly _tag: string;
    readonly reason?: unknown;
    readonly message: string;
  }) =>
    error._tag === "SystemError" && error.reason === "NotFound"
      ? new ProviderUnavailableError({
          provider: "namespace",
          reason: "ssh is not installed; install an OpenSSH client",
        })
      : new ProviderError({ provider: "namespace", reason: error.message });

  // Every independent CLI link gets its own control socket; two opens racing
  // on the same pid-named socket would unlink each other's live master. The
  // name stays short: ssh adds 17 characters while it binds, and macOS caps
  // a socket path at 103.
  let cliSeq = 0;

  const sshBase = (
    ctl: string,
    key: string,
    hosts: string,
    target: string,
    proxy?: string,
  ): ReadonlyArray<string> => [
    "-S",
    ctl,
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${hosts}`,
    "-o",
    "LogLevel=ERROR",
    ...KEEP_ALIVE,
    ...(proxy === undefined ? [] : ["-o", `ProxyCommand=${proxy}`]),
    target,
  ];

  const checkCtl = (ctl: string, target: string) =>
    Command.exitCode(
      Command.make(sshBin, "-S", ctl, "-O", "check", target),
    ).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.map((code) => code === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const exitCtl = (ctl: string, target: string) =>
    Command.exitCode(
      Command.make(sshBin, "-S", ctl, "-O", "exit", target),
    ).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.catchAll(() => Effect.succeed(0)),
      Effect.asVoid,
    );

  return (ref, paths, owner, route) =>
    Effect.gen(function* () {
      const targetOf = (gateway: string) =>
        route.to === "sshd" ? `${route.user}@127.0.0.1` : gateway;
      const sshFor = (ctl: string, key: string, gateway: string) =>
        route.to === "sshd"
          ? sshBase(
              ctl,
              paths.key,
              paths.sshdKnownHosts,
              targetOf(gateway),
              shellJoin([
                sshBin,
                "-i",
                key,
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                `UserKnownHostsFile=${paths.knownHosts}`,
                "-o",
                "LogLevel=ERROR",
                ...KEEP_ALIVE,
                "-W",
                "127.0.0.1:22",
                gateway,
              ]),
            )
          : sshBase(ctl, key, paths.knownHosts, gateway);
      // `up` makes sure the master is there before a command spawns: a
      // command on a dead master falls back to a new double ssh
      // connection, 5 to 14 s each (#259).
      const linkOver = (ssh: ReadonlyArray<string>, up: LinkUp): Link => ({
        ssh,
        run: (commandLine) =>
          Effect.zipRight(
            up,
            captureCommand(
              // An empty stdin, as in commandEvents: ssh forwards an open
              // pipe, and a remote command that reads it would wait forever.
              Command.stdin(
                Command.make(sshBin, ...ssh, commandLine),
                Stream.empty,
              ),
            ).pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
              Effect.mapError((error) => sshError(error)),
              Effect.flatMap((result) =>
                result.exitCode !== 255
                  ? Effect.succeed(result satisfies HostResult)
                  : Effect.fail(
                      result.stderr.includes("Host key verification failed")
                        ? hostKeyRefused(ref)
                        : linkLost(ref, lastLine(result.stderr)),
                    ),
              ),
            ),
          ),
        stream: (commandLine, options) =>
          Stream.unwrap(
            Effect.as(
              up,
              commandEvents<
                ProviderError | ProviderUnavailableError | LinkDroppedError
              >(
                executor,
                Command.make(sshBin, "-T", ...ssh, commandLine),
                options,
                {
                  spawn: sshError,
                  fail: (reason) =>
                    new ProviderError({ provider: "namespace", reason }),
                  exit: (code) =>
                    code === 255
                      ? Effect.fail(
                          new LinkDroppedError({
                            reason: linkLost(
                              ref,
                              "the ssh link dropped mid-command",
                            ).reason,
                          }),
                        )
                      : Effect.succeed(code),
                },
              ),
            ),
          ),
      });
      // A CLI call rides the Keeper's link when it is up — the Keeper holds
      // the one long-lived connection, so a warm exec never pays for a new
      // handshake.
      const keeperKey = `${paths.control.replace(/\.ctl$/, "")}.sshkey`;
      const targetFile = `${paths.control.replace(/\.ctl$/, "")}.sshtarget`;
      // A warm open rides the Keeper's ControlMaster; the stored target
      // saves the GetSSHConfig call a ride does not need.
      if (owner === "cli") {
        const stored = yield* fs.readFileString(targetFile).pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => ""),
        );
        if (
          stored !== "" &&
          (yield* checkCtl(paths.control, targetOf(stored)))
        ) {
          const ssh = sshFor(paths.control, keeperKey, stored);
          return linkOver(ssh, Effect.void);
        }
      }
      const { config, gateway } = yield* gatewayConfig(api, ref);
      const target = targetOf(gateway);
      if (owner === "cli" && (yield* checkCtl(paths.control, target))) {
        const ssh = sshFor(paths.control, keeperKey, gateway);
        return linkOver(ssh, Effect.void);
      }
      const ctl =
        owner === "keeper"
          ? paths.control
          : join(dirname(paths.control), `ns-c${process.pid}-${cliSeq++}.ctl`);
      // The gateway key is written once per open, next to the control socket
      // it belongs to, and removed when the link's scope closes. It cannot
      // share paths.key: ssh checks a <key>.pub next to the identity file,
      // and the .pub there belongs to the local keypair create made. The
      // host keys go to the per-Sandbox known_hosts file every open
      // refreshes.
      const key = `${ctl.replace(/\.ctl$/, "")}.sshkey`;
      yield* pinGateway(fs, config, { key, knownHosts: paths.knownHosts });
      yield* fs
        .writeFileString(targetFile, `${gateway}\n`, { mode: 0o600 })
        .pipe(
          Effect.mapError(
            (error) =>
              new ProviderError({
                provider: "namespace",
                reason: platformReason(error),
              }),
          ),
        );
      const ssh = sshFor(ctl, key, gateway);
      // A master that died mid-attempt can leave its socket file; each
      // attempt runs in its own scope so a failure drops the half-built
      // master before the next try. On success the attempt's scope is
      // parked on the caller's scope so the master lives until then, and
      // held so a reopen can drop the dead one first.
      const outerScope = yield* Scope.Scope;
      const held = yield* Ref.make(Option.none<Scope.CloseableScope>());
      const bringup = Effect.gen(function* () {
        const attemptScope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          // A dead master can leave its socket file behind; a later spawn
          // then refuses to multiplex ("ControlSocket already exists").
          yield* fs.remove(ctl, { force: true }).pipe(
            Effect.mapError(
              (error) =>
                new ProviderError({
                  provider: "namespace",
                  reason: platformReason(error),
                }),
            ),
          );
          const masterLog = yield* Ref.make("");
          const master = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const process = yield* Command.start(
                Command.make(sshBin, "-M", "-N", ...ssh),
              ).pipe(
                Effect.provideService(
                  CommandExecutor.CommandExecutor,
                  executor,
                ),
                Effect.mapError((error) => sshError(error)),
              );
              yield* Stream.runForEach(process.stderr, (bytes) =>
                Ref.update(
                  masterLog,
                  (text) => text + Buffer.from(bytes).toString("utf8"),
                ),
              ).pipe(Effect.forkScoped);
              return process;
            }),
            (process) =>
              Effect.zipRight(
                exitCtl(ctl, target),
                Effect.orElseSucceed(process.kill("SIGKILL"), () => undefined),
              ),
          );
          const up = checkCtl(ctl, target).pipe(
            Effect.filterOrFail(
              (ok) => ok,
              () => down("ssh did not connect in 15 s"),
            ),
          );
          yield* Effect.raceFirst(
            Effect.retry(
              up,
              Schedule.spaced("100 millis").pipe(Schedule.upTo("15 seconds")),
            ),
            master.exitCode.pipe(
              Effect.orElseSucceed(() => 255),
              Effect.zipRight(Ref.get(masterLog)),
              Effect.flatMap((text) =>
                Effect.fail(
                  text.includes("Host key verification failed")
                    ? hostKeyRefused(ref)
                    : down(lastLine(text === "" ? "ssh exited" : text)),
                ),
              ),
            ),
          );
        }).pipe(
          Scope.extend(attemptScope),
          Effect.onError(() =>
            Scope.close(attemptScope, Exit.fail("attempt failed")),
          ),
          Effect.tap(() =>
            Ref.set(held, Option.some(attemptScope)).pipe(
              Effect.zipRight(
                Scope.addFinalizer(
                  outerScope,
                  Scope.close(attemptScope, Exit.void),
                ),
              ),
            ),
          ),
        );
      });
      // A dead host drops the gateway link just like a cold one does; the
      // list check between attempts names the Sandbox gone instead of
      // burning the whole retry budget on a host that is already deleted.
      const attempt = bringup.pipe(
        Effect.catchTag("LinkDownError", (error) => goneOr(api, ref, error)),
      );
      const linkWait = yield* parseSpan(
        "PROOFBOX_NS_LINK_WAIT",
        yield* linkWaitText.pipe(
          Effect.mapError(
            (error) =>
              new ProviderError({
                provider: "namespace",
                reason: error.message,
              }),
          ),
        ),
        {
          units: ["ms", "s", "m"],
          zero: true,
          example: "120s",
        },
      ).pipe(
        Effect.mapError(
          (error) =>
            new ProviderError({ provider: "namespace", reason: error.message }),
        ),
      );
      const open = (wait: Duration.Duration) =>
        Effect.retry(attempt, {
          while: (error) => error instanceof LinkDownError,
          schedule: Schedule.spaced("1 second").pipe(Schedule.upTo(wait)),
        }).pipe(
          Effect.catchTag("LinkDownError", (error) =>
            Effect.fail(linkLost(ref, error.detail)),
          ),
        );
      // A reopen runs inside a command's 120 s helper limit (ADR 0019): a
      // command can wait behind one failed reopen and then run its own,
      // and each can run one 15 s bring-up past its budget, so two must
      // fit.
      const reopenWait = Duration.min(linkWait, Duration.seconds(20));
      // One reopen at a time: two would each remove the other's socket.
      const permit = yield* Effect.makeSemaphore(1);
      const reopen: LinkUp = permit.withPermits(1)(
        Effect.gen(function* () {
          if (yield* checkCtl(ctl, target)) {
            return;
          }
          // The old attempt's release sends `-O exit` on `ctl`, so it must
          // run before a new master binds there.
          const dead = yield* Ref.getAndSet(held, Option.none());
          if (Option.isSome(dead)) {
            yield* Scope.close(dead.value, Exit.void);
          }
          const start = yield* Clock.currentTimeMillis;
          yield* open(reopenWait);
          if (owner === "keeper") {
            const now = yield* Clock.currentTimeMillis;
            yield* writeKeeperLog(paths.log, {
              at: new Date(now),
              kind: "link",
              program: "reopen",
              out: 0,
              err: 0,
              exit: undefined,
              firstMs: undefined,
              tookMs: now - start,
              ended: "done",
            }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          }
        }),
      );
      if (yield* checkCtl(ctl, target)) {
        // A master another process left on the Keeper's socket, as a Keeper
        // killed with SIGKILL leaves it.
        const up = owner === "keeper" ? reopen : Effect.void;
        return linkOver(ssh, up);
      }
      yield* open(linkWait);
      return linkOver(ssh, reopen);
    });
};

// The Live view's local port: `ssh -L` through the same GetSSHConfig
// gateway the links use. GetVNCConfig answers a WebSocket behind an
// ingress auth header that no VNC app sends (docs/test-decisions.md 14).
// Scoped: the forward lives until the scope closes; `gone`
// resolves with the failure if the ssh process exits after the port is
// up. `ref` names the Sandbox the forward serves.
export type SshForward = (
  ref: SandboxRef,
  port: number,
) => Effect.Effect<
  {
    readonly port: number;
    readonly gone: Effect.Effect<never, ProviderError | SandboxGoneError>;
  },
  ApiError | ApiLoginError,
  Scope.Scope
>;

export const makeSshForward = (
  api: NamespaceApi,
  executor: CommandExecutor.CommandExecutor,
  fs: FileSystem.FileSystem,
  sshBin = "ssh",
): SshForward => {
  let seq = 0;
  const fail = (reason: string) =>
    new ProviderError({ provider: "namespace", reason });
  return (ref, port) =>
    Effect.gen(function* () {
      const { config, gateway: target } = yield* gatewayConfig(api, ref);
      const dir = yield* runtimeDir("ns").pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const pid = process.pid;
      const key = join(dir, `ns-f${pid}-${seq++}.sshkey`);
      const hosts = `${key}.known-hosts`;
      yield* pinGateway(fs, config, { key, knownHosts: hosts });
      yield* Effect.addFinalizer(() =>
        fs.remove(hosts, { force: true }).pipe(Effect.ignore),
      );
      // OpenSSH 8.9 rejects `-L 0:` so the local port is picked here; a
      // bind that lost the race exits at once under ExitOnForwardFailure.
      const local = yield* Effect.tryPromise({
        try: () =>
          new Promise<number>((resolve, reject) => {
            const server = createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              server.close(() =>
                resolve(
                  typeof address === "object" && address !== null
                    ? address.port
                    : 0,
                ),
              );
            });
          }),
        catch: (cause) => fail(causeText(cause)),
      });
      const proc = yield* Effect.acquireRelease(
        Command.start(
          Command.make(
            sshBin,
            "-N",
            "-T",
            "-v",
            "-i",
            key,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `UserKnownHostsFile=${hosts}`,
            ...KEEP_ALIVE,
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            `127.0.0.1:${local}:127.0.0.1:${port}`,
            target,
          ),
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.mapError((error) =>
            error._tag === "SystemError" && error.reason === "NotFound"
              ? new ProviderUnavailableError({
                  provider: "namespace",
                  reason: "ssh is not installed; install an OpenSSH client",
                })
              : fail(error.message),
          ),
        ),
        (proc) => Effect.orElseSucceed(proc.kill("SIGKILL"), () => undefined),
      );
      const stderr = yield* Ref.make("");
      const stderrDone = yield* Deferred.make<void>();
      const listening = yield* Deferred.make<number>();
      // Both pipes stay open for the life of the process — a closed read
      // side can kill the writer. `-v` logs the bound port on stderr:
      // "debug1: Local forwarding listening on 127.0.0.1 port N".
      yield* Stream.runForEach(proc.stdout, () => Effect.void).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(proc.stderr, (bytes) =>
        Effect.gen(function* () {
          const text = yield* Ref.updateAndGet(
            stderr,
            (all) => all + Buffer.from(bytes).toString("utf8"),
          );
          const match =
            /Local forwarding listening on 127\.0\.0\.1 port (\d+)/.exec(text);
          if (match !== null) {
            yield* Deferred.complete(
              listening,
              Effect.succeed(Number(match[1])),
            );
          }
        }),
      ).pipe(
        Effect.ensuring(Deferred.complete(stderrDone, Effect.void)),
        Effect.forkScoped,
      );
      const gone: Effect.Effect<never, ProviderError | SandboxGoneError> =
        proc.exitCode.pipe(
          Effect.orElseSucceed(() => 1),
          // The stderr drain can lag the exit by a beat; give it a moment so
          // the exit line still lands in the reported reason.
          Effect.zipRight(
            Deferred.await(stderrDone).pipe(
              Effect.timeout("2 seconds"),
              Effect.ignore,
            ),
          ),
          Effect.zipRight(Ref.get(stderr)),
          Effect.flatMap((text) =>
            goneOr(
              api,
              ref,
              fail(`the Live view's forward died: ${lastLine(text)}`),
            ),
          ),
        );
      const bound = yield* Effect.raceFirst(Deferred.await(listening), gone);
      return { port: bound, gone };
    });
};
