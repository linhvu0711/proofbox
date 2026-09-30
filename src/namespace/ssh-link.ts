import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import {
  Chunk,
  Data,
  Effect,
  Exit,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { commandEvents } from "../command-events.ts";
import {
  ProviderError,
  ProviderUnavailableError,
  SandboxGoneError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";
import type { ApiError, ApiLoginError, NamespaceApi } from "./namespace-api.ts";
import { splitHostName } from "./regions.ts";

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
  ) => Effect.Effect<HostResult, ProviderError | ProviderUnavailableError>;
  readonly stream: (
    commandLine: string,
    options?: ExecOptions,
  ) => Stream.Stream<ExecEvent, ProviderError | ProviderUnavailableError>;
}

export type LinkOwner = "keeper" | "cli";

export type OpenLink = (
  id: string,
  paths: KeeperPaths,
  owner: LinkOwner,
) => Effect.Effect<Link, ApiError | ApiLoginError, Scope.Scope>;

const toText = (chunks: Chunk.Chunk<Uint8Array>) =>
  Buffer.concat(Chunk.toReadonlyArray(chunks).map((bytes) => bytes)).toString(
    "utf8",
  );

const tail = (text: string, lines: number) =>
  text.trim().split("\n").slice(-lines).join("\n");

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const linkLost = (detail: string) =>
  new ProviderUnavailableError({
    provider: "namespace",
    reason: `lost the link to the Namespace host: ${detail}`,
  });

// Bring-up failures that mean "the link is not ready yet" — the SSH
// gateway still coming up, a handshake that dropped. Only these are
// retried; a missing ssh binary or not being logged in fails at once.
// After the retries give up it is mapped to the linkLost
// ProviderUnavailableError.
class LinkDownError extends Data.TaggedError("LinkDownError")<{
  readonly detail: string;
}> {}
const down = (detail: string) => new LinkDownError({ detail });

export const makeOpenLink = (
  api: NamespaceApi,
  executor: CommandExecutor.CommandExecutor,
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
    target,
  ];

  const checkCtl = (ctl: string, target: string) =>
    Command.exitCode(
      Command.make("ssh", "-S", ctl, "-O", "check", target),
    ).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.map((code) => code === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const exitCtl = (ctl: string, target: string) =>
    Command.exitCode(Command.make("ssh", "-S", ctl, "-O", "exit", target)).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.catchAll(() => Effect.succeed(0)),
      Effect.asVoid,
    );

  return (id, paths, owner) =>
    Effect.gen(function* () {
      const runWith = (ssh: ReadonlyArray<string>) => (commandLine: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Command.start(
              Command.make("ssh", ...ssh, commandLine),
            ).pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor),
              Effect.mapError((error) => sshError(error)),
            );
            const [outBytes, errBytes, exitCode] = yield* Effect.all(
              [
                Stream.runCollect(process.stdout),
                Stream.runCollect(process.stderr),
                process.exitCode,
              ],
              { concurrency: "unbounded" },
            ).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderError({
                    provider: "namespace",
                    reason: describe(error),
                  }),
              ),
            );
            const stderr = toText(errBytes);
            if (exitCode === 255) {
              return yield* linkLost(tail(stderr, 3));
            }
            return {
              exitCode,
              stdout: toText(outBytes),
              stderr,
            } satisfies HostResult;
          }),
        );
      const streamWith =
        (ssh: ReadonlyArray<string>) =>
        (commandLine: string, options?: ExecOptions) =>
          commandEvents<ProviderError | ProviderUnavailableError>(
            executor,
            Command.make("ssh", "-T", ...ssh, commandLine),
            options,
            {
              spawn: sshError,
              fail: (reason) =>
                new ProviderError({ provider: "namespace", reason }),
              exit: (code) =>
                code === 255
                  ? Effect.fail(linkLost("the ssh link dropped mid-command"))
                  : Effect.succeed(code),
            },
          );
      // A CLI call rides the Keeper's link when it is up — the Keeper holds
      // the one long-lived connection, so a warm exec never pays for a new
      // handshake.
      const { region, instanceId } = splitHostName(id);
      const keeperKey = `${paths.control.replace(/\.ctl$/, "")}.sshkey`;
      const targetFile = `${paths.control.replace(/\.ctl$/, "")}.sshtarget`;
      // A warm open rides the Keeper's ControlMaster; the stored target
      // saves the GetSSHConfig call a ride does not need.
      if (owner === "cli") {
        const stored = yield* Effect.promise(() =>
          readFile(targetFile, "utf8")
            .then((text) => text.trim())
            .catch(() => ""),
        );
        if (stored !== "" && (yield* checkCtl(paths.control, stored))) {
          const ssh = sshBase(
            paths.control,
            keeperKey,
            paths.knownHosts,
            stored,
          );
          return {
            ssh,
            run: runWith(ssh),
            stream: streamWith(ssh),
          } satisfies Link;
        }
      }
      const cfg = yield* api.sshConfig(region, instanceId);
      const target = `${cfg.username}@${cfg.endpoint}`;
      if (owner === "cli" && (yield* checkCtl(paths.control, target))) {
        const ssh = sshBase(paths.control, keeperKey, paths.knownHosts, target);
        return {
          ssh,
          run: runWith(ssh),
          stream: streamWith(ssh),
        } satisfies Link;
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
      yield* Effect.tryPromise({
        try: () =>
          writeFile(key, cfg.privateKey, { mode: 0o600 }).then(() =>
            chmod(key, 0o600),
          ),
        catch: (cause) =>
          new ProviderError({
            provider: "namespace",
            reason: describe(cause),
          }),
      });
      yield* Effect.tryPromise({
        try: () => writeFile(targetFile, `${target}\n`, { mode: 0o600 }),
        catch: (cause) =>
          new ProviderError({
            provider: "namespace",
            reason: describe(cause),
          }),
      });
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            paths.knownHosts,
            `${cfg.hostKeys.map((hostKey) => `${cfg.endpoint} ${hostKey}`).join("\n")}\n`,
            { mode: 0o600 },
          ),
        catch: (cause) =>
          new ProviderError({
            provider: "namespace",
            reason: describe(cause),
          }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(key, { force: true }).catch(() => undefined)),
      );
      const ssh = sshBase(ctl, key, paths.knownHosts, target);
      const run = runWith(ssh);
      const stream = streamWith(ssh);
      if (yield* checkCtl(ctl, target)) {
        return { ssh, run, stream } satisfies Link;
      }
      // A master that died mid-attempt can leave its socket file; each
      // attempt runs in its own scope so a failure drops the half-built
      // master before the next try. On success the attempt's scope is
      // parked on the caller's scope so the master lives until then.
      const outerScope = yield* Scope.Scope;
      const bringup = Effect.gen(function* () {
        const attemptScope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          // A dead master can leave its socket file behind; a later spawn
          // then refuses to multiplex ("ControlSocket already exists").
          yield* Effect.tryPromise({
            try: () => rm(ctl, { force: true }),
            catch: (cause) =>
              new ProviderError({
                provider: "namespace",
                reason: describe(cause),
              }),
          });
          const masterLog = yield* Ref.make("");
          const master = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const process = yield* Command.start(
                Command.make("ssh", "-M", "-N", ...ssh),
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
                Effect.fail(down(tail(text === "" ? "ssh exited" : text, 3))),
              ),
            ),
          );
        }).pipe(
          Scope.extend(attemptScope),
          Effect.onError(() =>
            Scope.close(attemptScope, Exit.fail("attempt failed")),
          ),
          Effect.tap(() =>
            Scope.addFinalizer(
              outerScope,
              Scope.close(attemptScope, Exit.void),
            ),
          ),
        );
      });
      // A dead host drops the gateway link just like a cold one does; the
      // list check between attempts names the Sandbox gone instead of
      // burning the whole retry budget on a host that is already deleted.
      const attempt = bringup.pipe(
        Effect.catchTag(
          "LinkDownError",
          (error): Effect.Effect<never, LinkDownError | SandboxGoneError> =>
            api.list(region, []).pipe(
              Effect.catchAll(() => Effect.fail(error)),
              Effect.flatMap(
                (
                  instances,
                ): Effect.Effect<never, LinkDownError | SandboxGoneError> =>
                  instances.some((instance) => instance.id === instanceId)
                    ? Effect.fail(error)
                    : Effect.fail(new SandboxGoneError({ id: `ns:${id}` })),
              ),
            ),
        ),
      );
      yield* Effect.retry(attempt, {
        while: (error) => error instanceof LinkDownError,
        schedule: Schedule.spaced("1 second").pipe(
          Schedule.upTo("120 seconds"),
        ),
      }).pipe(
        Effect.catchTag("LinkDownError", (error) =>
          Effect.fail(linkLost(error.detail)),
        ),
      );
      return { ssh, run, stream } satisfies Link;
    });
};
