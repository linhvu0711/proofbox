import { rm } from "node:fs/promises";
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
  type SandboxGoneError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";
import type { NscClient } from "./nsc-client.ts";

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
) => Effect.Effect<
  Link,
  ProviderError | ProviderUnavailableError | SandboxGoneError,
  Scope.Scope
>;

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

// Bring-up failures that mean "the host is not ready yet" — sshd still
// coming up, a tunnel that dropped. Only these are retried; a missing ssh
// or nsc, or not being logged in, fails at once. After the retries give up
// it is mapped to the linkLost ProviderUnavailableError.
class LinkDownError extends Data.TaggedError("LinkDownError")<{
  readonly detail: string;
}> {}
const down = (detail: string) => new LinkDownError({ detail });

export const makeOpenLink = (
  nsc: NscClient,
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
  // on the same pid-named socket would unlink each other's live master.
  let cliSeq = 0;

  const sshBase = (ctl: string, key: string): ReadonlyArray<string> => [
    "-S",
    ctl,
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "root@127.0.0.1",
  ];

  const checkCtl = (ctl: string) =>
    Command.exitCode(
      Command.make("ssh", "-S", ctl, "-O", "check", "root@127.0.0.1"),
    ).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.map((code) => code === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const exitCtl = (ctl: string) =>
    Command.exitCode(
      Command.make("ssh", "-S", ctl, "-O", "exit", "root@127.0.0.1"),
    ).pipe(
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
      // forward or handshake.
      if (owner === "cli" && (yield* checkCtl(paths.control))) {
        const ssh = sshBase(paths.control, paths.key);
        return {
          ssh,
          run: runWith(ssh),
          stream: streamWith(ssh),
        } satisfies Link;
      }
      const ctl =
        owner === "keeper"
          ? paths.control
          : paths.control.replace(/\.ctl$/, `-${process.pid}-${cliSeq++}.ctl`);
      const ssh = sshBase(ctl, paths.key);
      const run = runWith(ssh);
      const stream = streamWith(ssh);
      if (yield* checkCtl(ctl)) {
        return { ssh, run, stream } satisfies Link;
      }
      // The host's sshd may still be starting when nsc reports the instance,
      // and a port-forward whose first connection dies stops listening, so
      // each attempt opens a fresh forward and master. An attempt's scope
      // cleans up on failure; on success it is parked on the caller's scope.
      const outerScope = yield* Scope.Scope;
      const bringup = Effect.gen(function* () {
        const attemptScope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const localPort = yield* nsc
            .portForward(id, 22)
            .pipe(Effect.map((forward) => forward.port));
          // The forward binds its local port before the tunnel to the host
          // is up; a connection that lands first is reset, which also drops
          // the listener, so give the tunnel a beat before the master dials.
          yield* Effect.sleep("1 second");
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
                Command.make(
                  "ssh",
                  "-M",
                  "-N",
                  "-p",
                  String(localPort),
                  ...ssh,
                ),
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
                exitCtl(ctl),
                Effect.orElseSucceed(process.kill("SIGKILL"), () => undefined),
              ),
          );
          const up = checkCtl(ctl).pipe(
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
      yield* Effect.retry(bringup, {
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
