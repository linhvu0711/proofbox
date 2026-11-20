import { Command, FileSystem } from "@effect/platform";
import {
  Clock,
  Duration,
  Effect,
  Either,
  HashSet,
  Layer,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { runCommand } from "../command-checks.ts";
import { captureCommand } from "../command-events.ts";
import {
  AnswerTimeoutError,
  KeeperLostError,
  LinkDroppedError,
  localFailure,
  ProviderError,
  SandboxGoneError,
  type UploadFailedError,
  type WorkFileGrewError,
} from "../errors.ts";
import { Progress } from "../progress.ts";
import {
  type ExecEvent,
  type ExecOptions,
  type Provider,
  Providers,
  type SandboxCallError,
  type SandboxRef,
} from "../provider.ts";
import {
  formatSandboxId,
  type ResolvedSandboxId,
  resolveSandboxId,
} from "../sandbox-id.ts";
import { spawnDetached } from "../spawn-detached.ts";
import { removeKeeperFiles } from "./lifecycle.ts";
import { keeperPathsOf } from "./paths.ts";
import {
  connectKeeper,
  encodeInput,
  encodeRequest,
  type RequestFrame,
  readReplies,
  writeFrame,
} from "./protocol.ts";

// The Sandbox as the Provider reads it once the Keeper is lost: a gone
// Sandbox fails gone, and any other failure keeps the lost reason.
const readAfterLost = Effect.fn("keeperClient.readAfterLost")(function* (
  provider: Provider,
  sandbox: SandboxRef,
  reason: string,
) {
  return yield* Effect.catchIf(
    provider.get(sandbox),
    (error) => !(error instanceof SandboxGoneError),
    () => Effect.fail(new ProviderError({ provider: provider.name, reason })),
  );
});

// The Caller side may send a stream whose failure is an upload error, not a
// ProviderError (packFiles can fail with UploadFailedError or
// WorkFileGrewError); when that stream feeds a real Connection.exec it is
// narrowed back to ProviderError.
type StdinError = ProviderError | UploadFailedError | WorkFileGrewError;

// How long a command may go without its answer: the whole call, or the
// gap between two events (a download that keeps moving never fails).
export type AnswerLimit =
  | { readonly whole: Duration.Duration }
  | { readonly idle: Duration.Duration };

export interface KeeperExecOptions {
  readonly stdin?: Stream.Stream<Uint8Array, StdinError>;
  readonly limit?: AnswerLimit;
}

export type KeeperExecError =
  | SandboxCallError
  | LinkDroppedError
  | UploadFailedError
  | WorkFileGrewError
  | AnswerTimeoutError;

// Fails the events with AnswerTimeoutError once the limit passes with no
// answer, after `giveUp` tells the other end. An idle limit counts only
// new stdout bytes, the file a download writes; stderr keeps no download
// alive. With no limit the events run as they are: `exec` has none
// (ADR 0019).
const withAnswerLimit = <E, R>(
  events: Stream.Stream<ExecEvent, E, R>,
  limit: AnswerLimit | undefined,
  giveUp: Effect.Effect<void>,
): Stream.Stream<ExecEvent, E | AnswerTimeoutError, R> => {
  if (limit === undefined) {
    return events;
  }
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const last = yield* Ref.make(yield* Clock.currentTimeMillis);
      const watch =
        "whole" in limit
          ? Effect.sleep(limit.whole)
          : Effect.gen(function* () {
              const idle = Duration.toMillis(limit.idle);
              while (true) {
                const quiet =
                  (yield* Clock.currentTimeMillis) - (yield* Ref.get(last));
                if (quiet >= idle) {
                  return;
                }
                yield* Effect.sleep(Duration.millis(idle - quiet));
              }
            });
      const after = "whole" in limit ? limit.whole : limit.idle;
      return events.pipe(
        Stream.tap((event) =>
          event._tag === "Stdout" && event.bytes.length > 0
            ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Ref.set(last, now),
              )
            : Effect.void,
        ),
        Stream.interruptWhen(
          watch.pipe(
            Effect.zipRight(giveUp),
            Effect.zipRight(Effect.fail(new AnswerTimeoutError({ after }))),
          ),
        ),
      );
    }),
  );
};

const narrowStdin = (options?: KeeperExecOptions): ExecOptions | undefined =>
  options?.stdin === undefined
    ? undefined
    : {
        stdin: Stream.mapError(options.stdin, (error) =>
          error instanceof ProviderError ? error : localFailure(error),
        ),
      };

// Without a Keeper the stdin stream feeds the command run, which narrows its
// failure to a ProviderError; keep the stdin error and report it in place of
// the wrapped one, as the Keeper path does with feederError.
const execDirect = Effect.fn("keeperClient.execDirect")(function* (
  provider: Provider,
  sandbox: SandboxRef,
  argv: ReadonlyArray<string>,
  options?: KeeperExecOptions,
) {
  const connection = yield* provider.connect(sandbox);
  const stdinError = yield* Ref.make<StdinError | undefined>(undefined);
  const fed =
    options?.stdin === undefined
      ? options
      : {
          stdin: options.stdin.pipe(
            Stream.tapError((error) => Ref.set(stdinError, error)),
          ),
        };
  const events: Stream.Stream<ExecEvent, KeeperExecError> = runCommand(
    connection,
    argv,
    narrowStdin(fed),
  ).pipe(
    Stream.catchAll((execError) =>
      Stream.unwrap(
        Ref.get(stdinError).pipe(
          Effect.map(
            (error): Stream.Stream<never, KeeperExecError> =>
              error === undefined ? Stream.fail(execError) : Stream.fail(error),
          ),
        ),
      ),
    ),
  );
  return withAnswerLimit(events, options?.limit, Effect.void);
});

export class KeeperClient extends Effect.Service<KeeperClient>()(
  "proofbox/KeeperClient",
  {
    effect: Effect.gen(function* () {
      const providers = yield* Providers;
      const progress = yield* Progress;
      // File access for the Keeper's files, taken once when the client is
      // built.
      const fs = yield* FileSystem.FileSystem;
      const warned = yield* Ref.make(false);

      // One Keeper line per run, the first caller's.
      const warnNotStarted = Effect.fn("KeeperClient.warnNotStarted")(
        function* (text: string) {
          if (!(yield* Ref.getAndSet(warned, true))) {
            yield* progress.warn(text);
          }
        },
      );

      // The Sandboxes whose Keeper failed to start in this run: a later
      // command of the run goes without one, and does not wait again.
      const failedStarts = yield* Ref.make(HashSet.empty<string>());

      // Starts the Keeper of Sandbox `id` and waits until its socket
      // answers. `stale` is the code a connect to the old socket path gave:
      // the new Keeper clears that path under its start lock, so it is
      // waited out too.
      const spawnKeeper = Effect.fn("KeeperClient.spawnKeeper")(function* (
        id: ResolvedSandboxId,
        stale?: string,
      ) {
        const paths = yield* keeperPathsOf(id);
        yield* spawnDetached(id.provider.name, "keeper/keeper-main", [
          formatSandboxId({
            provider: id.prefix,
            region: id.region,
            name: id.name,
          }),
        ]).pipe(
          Effect.zipRight(
            connectKeeper(paths.socket, id.provider.name).pipe(
              Effect.retry({
                while: (error) =>
                  error.reason === "ENOENT" ||
                  error.reason === "ECONNREFUSED" ||
                  error.reason === stale,
                schedule: Schedule.spaced("50 millis").pipe(
                  Schedule.upTo("10 seconds"),
                ),
              }),
            ),
          ),
          Effect.tap((socket) => Effect.sync(() => socket.destroy())),
          Effect.tapError(() =>
            Ref.update(failedStarts, HashSet.add(paths.socket)),
          ),
        );
      });

      // A socket to the Keeper of Sandbox `id` that has taken `request`, or
      // the Provider's read of the Sandbox when no Keeper takes it. Any
      // failure to talk to the Keeper counts as no Keeper, and a new one
      // starts, since losing a Keeper changes nothing.
      const reach = Effect.fn("KeeperClient.reach")(function* (
        id: ResolvedSandboxId,
        request: RequestFrame,
      ) {
        const paths = yield* keeperPathsOf(id);
        // The Keeper never read a request it dropped, so after a new Keeper
        // starts the request goes again.
        const connect = connectKeeper(paths.socket, id.provider.name).pipe(
          Effect.tap((socket) =>
            writeFrame(socket, id.provider.name, encodeRequest(request)),
          ),
        );
        return yield* connect.pipe(
          Effect.map((socket) => Either.right(socket)),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              // With no Keeper, the Provider says first whether the Sandbox
              // is still there: a gone one fails here, with no Keeper
              // started for it.
              const read = yield* id.provider.get(id);
              if (HashSet.has(yield* Ref.get(failedStarts), paths.socket)) {
                return Either.left(read);
              }
              return yield* Effect.zipRight(
                spawnKeeper(id, error.reason),
                connect,
              ).pipe(
                Effect.map((socket) => Either.right(socket)),
                Effect.orElseSucceed(() => Either.left(read)),
              );
            }),
          ),
        );
      });

      // Ends the Keeper of Sandbox `id`, if one runs, and removes its files.
      const endKeeper = Effect.fn("KeeperClient.endKeeper")(function* (
        id: ResolvedSandboxId,
      ) {
        const paths = yield* keeperPathsOf(id);
        const pidText = yield* fs
          .readFileString(paths.pid)
          .pipe(Effect.orElseSucceed(() => ""));
        const pid = Number.parseInt(pidText.trim(), 10);
        if (Number.isFinite(pid)) {
          // A stale pid file can name a reused, unrelated pid; only signal a
          // process that still runs keeper-main.
          const isKeeper = yield* captureCommand(
            Command.make("ps", "-p", String(pid), "-o", "command="),
          ).pipe(
            Effect.map(
              ({ exitCode, stdout }) =>
                exitCode === 0 && stdout.includes("keeper-main"),
            ),
            Effect.orElseSucceed(() => false),
          );
          if (isKeeper) {
            yield* Effect.sync(() => {
              try {
                process.kill(pid, "SIGTERM");
              } catch {
                // ESRCH and friends: Keeper already gone
              }
            });
          }
        }
        yield* removeKeeperFiles(paths);
      });

      const start = Effect.fn("KeeperClient.start")(
        function* (rawId: string) {
          yield* spawnKeeper(yield* resolveSandboxId(rawId, providers));
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      const exec = Effect.fn("KeeperClient.exec")(
        function* (
          rawId: string,
          argv: ReadonlyArray<string>,
          options?: KeeperExecOptions,
        ) {
          const id = yield* resolveSandboxId(rawId, providers);
          const provider = id.provider;
          const reached = yield* reach(
            id,
            options?.stdin === undefined
              ? { exec: [...argv] }
              : { exec: [...argv], stdin: true },
          );
          if (Either.isLeft(reached)) {
            yield* warnNotStarted("Keeper did not start; running without it");
            return yield* execDirect(provider, id, argv, options);
          }
          const socket = reached.right;
          const feederError = yield* Ref.make<StdinError | undefined>(
            undefined,
          );
          if (options?.stdin !== undefined) {
            const stdin = options.stdin;
            yield* Effect.forkScoped(
              Stream.runForEach(stdin, (chunk) =>
                writeFrame(
                  socket,
                  id.provider.name,
                  encodeInput({ in: Buffer.from(chunk).toString("base64") }),
                ),
              ).pipe(
                Effect.zipRight(
                  writeFrame(
                    socket,
                    id.provider.name,
                    encodeInput({ end: true }),
                  ),
                ),
                Effect.catchAll((error) =>
                  Effect.zipRight(
                    Ref.set(feederError, error),
                    Effect.sync(() => {
                      socket.destroy();
                    }),
                  ),
                ),
              ),
            );
          }
          const lostOnCommand = (reason: string) =>
            Effect.flatMap(readAfterLost(provider, id, reason), () =>
              Effect.fail(
                new ProviderError({ provider: provider.name, reason }),
              ),
            );
          const events: Stream.Stream<ExecEvent, KeeperExecError> = readReplies(
            socket,
            id.provider.name,
          ).pipe(
            Stream.mapEffect(
              (
                frame,
              ): Effect.Effect<
                ExecEvent,
                ProviderError | SandboxGoneError | LinkDroppedError
              > => {
                if ("out" in frame) {
                  return Effect.succeed({
                    _tag: "Stdout",
                    bytes: new Uint8Array(Buffer.from(frame.out, "base64")),
                  });
                }
                if ("err" in frame) {
                  return Effect.succeed({
                    _tag: "Stderr",
                    bytes: new Uint8Array(Buffer.from(frame.err, "base64")),
                  });
                }
                if ("exit" in frame) {
                  return Effect.succeed(
                    frame.kills === undefined
                      ? { _tag: "Exit", code: frame.exit }
                      : {
                          _tag: "Exit",
                          code: frame.exit,
                          kills: {
                            before: frame.kills[0],
                            after: frame.kills[1],
                          },
                        },
                  );
                }
                if ("gone" in frame) {
                  return Effect.fail(new SandboxGoneError({ id: frame.gone }));
                }
                if ("dropped" in frame) {
                  return Effect.fail(
                    new LinkDroppedError({ reason: frame.dropped }),
                  );
                }
                return Effect.fail(
                  new ProviderError({
                    provider: provider.name,
                    reason:
                      "fail" in frame
                        ? frame.fail
                        : "the Keeper sent Sandbox info for a command",
                  }),
                );
              },
            ),
            Stream.catchAll((frameError) =>
              Stream.unwrap(
                Ref.get(feederError).pipe(
                  Effect.map(
                    (fed): Stream.Stream<never, KeeperExecError> =>
                      fed !== undefined
                        ? Stream.fail(fed)
                        : frameError instanceof KeeperLostError
                          ? Stream.fromEffect(
                              lostOnCommand(
                                frameError.reason ??
                                  "Keeper closed the connection before the command exited",
                              ),
                            )
                          : Stream.fail(frameError),
                  ),
                ),
              ),
            ),
          );
          // The give-up frame leaves before the stream's release destroys
          // the socket, so the Keeper knows the Caller gave up, not left.
          return withAnswerLimit(
            events,
            options?.limit,
            writeFrame(
              socket,
              id.provider.name,
              encodeInput({ giveUp: true }),
            ).pipe(Effect.ignore),
          );
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      const stop = Effect.fn("KeeperClient.stop")(
        function* (rawId: string) {
          yield* endKeeper(yield* resolveSandboxId(rawId, providers));
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      // The Sandbox as the warm Keeper read it at connect, with no remote
      // call. With no Keeper answering, reach starts one; when none starts,
      // the Provider's read stands.
      const info = Effect.fn("KeeperClient.info")(
        function* (rawId: string) {
          const id = yield* resolveSandboxId(rawId, providers);
          const reached = yield* reach(id, { info: true });
          if (Either.isLeft(reached)) {
            return reached.left;
          }
          const socket = reached.right;
          // The reader never ends before a last frame, so an empty reply
          // counts as a close.
          const reply = yield* readReplies(socket, id.provider.name).pipe(
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new KeeperLostError({})),
                onSome: (frame) => Effect.succeed(frame),
              }),
            ),
            Effect.catchTag("KeeperLostError", (lost) =>
              Effect.map(
                readAfterLost(
                  id.provider,
                  id,
                  lost.reason ??
                    "Keeper closed the connection before it answered",
                ),
                (info) => ({ info }),
              ),
            ),
          );
          if ("info" in reply) {
            return reply.info;
          }
          // A Keeper from an older build cannot read the request and would
          // run commands with no Deadline push: stop it, so the next command
          // starts a new one.
          if ("fail" in reply && reply.fail === "bad request") {
            yield* endKeeper(id);
            return yield* id.provider.get(id);
          }
          return yield* new ProviderError({
            provider: id.provider.name,
            reason:
              "fail" in reply ? reply.fail : "the Keeper sent no Sandbox info",
          });
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      return { start, exec, info, stop, warnNotStarted };
    }),
  },
) {
  static Direct = Layer.effect(
    KeeperClient,
    Effect.gen(function* () {
      const providers = yield* Providers;
      return new KeeperClient({
        start: () => Effect.void,
        warnNotStarted: () => Effect.void,
        stop: () => Effect.void,
        info: (rawId: string) =>
          Effect.flatMap(resolveSandboxId(rawId, providers), (id) =>
            id.provider.get(id),
          ),
        exec: Effect.fn("KeeperClient.Direct.exec")(function* (
          rawId: string,
          argv: ReadonlyArray<string>,
          options?: KeeperExecOptions,
        ) {
          const id = yield* resolveSandboxId(rawId, providers);
          return yield* execDirect(id.provider, id, argv, options);
        }),
      });
    }),
  );
}
