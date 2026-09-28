import { rm } from "node:fs/promises";
import { Command, CommandExecutor } from "@effect/platform";
import { Chunk, Effect, Exit, Ref, Schedule, Scope, Stream } from "effect";
import {
  ProviderError,
  ProviderUnavailableError,
  type SandboxGoneError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import type { NscClient } from "./nsc-client.ts";

export interface HostResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// A Link is one ssh connection to the host: `ssh` is the argument tail for
// `ssh <...> <command line>` (reusing the ControlMaster when one is up),
// and `run` runs a remote shell line over it.
export interface Link {
  readonly ssh: ReadonlyArray<string>;
  readonly run: (
    commandLine: string,
  ) => Effect.Effect<HostResult, ProviderError | ProviderUnavailableError>;
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
      const ctl =
        owner === "keeper"
          ? paths.control
          : paths.control.replace(/\.ctl$/, `-${process.pid}.ctl`);
      const ssh = sshBase(ctl, paths.key);
      const run = (commandLine: string) =>
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
      if (yield* checkCtl(ctl)) {
        return { ssh, run } satisfies Link;
      }
      // The host's sshd may still be starting when nsc reports the instance,
      // and a port-forward whose first connection dies stops listening, so
      // each attempt opens a fresh forward and master. An attempt's scope
      // cleans up on failure; on success it is parked on the caller's scope.
      const outerScope = yield* Scope.Scope;
      const bringup = Effect.gen(function* () {
        const attemptScope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const localPort = yield* nsc.portForward(id, 22);
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
              () => linkLost("ssh did not connect in 15 s"),
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
                  linkLost(tail(text === "" ? "ssh exited" : text, 3)),
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
            Scope.addFinalizer(
              outerScope,
              Scope.close(attemptScope, Exit.void),
            ),
          ),
        );
      });
      yield* Effect.retry(bringup, {
        while: (error) => error instanceof ProviderUnavailableError,
        schedule: Schedule.spaced("1 second").pipe(
          Schedule.upTo("120 seconds"),
        ),
      });
      return { ssh, run } satisfies Link;
    });
};
