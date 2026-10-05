import { FileSystem } from "@effect/platform";
import { Clock, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import { runCommand } from "../command-checks.ts";
import {
  AnswerTimeoutError,
  KeeperLostError,
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
import { fileStem, resolveSandboxId } from "../sandbox-id.ts";
import {
  keeperAway,
  reachKeeper,
  startKeeper,
  stopKeeper,
} from "./lifecycle.ts";
import { keeperPaths } from "./paths.ts";
import {
  connectKeeper,
  encodeInput,
  encodeRequest,
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
          error instanceof ProviderError
            ? error
            : new ProviderError({
                provider: "local",
                reason: error instanceof Error ? error.message : String(error),
              }),
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

      const start = Effect.fn("KeeperClient.start")(
        function* (rawId: string) {
          yield* startKeeper(yield* resolveSandboxId(rawId, providers));
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
          const socket = yield* reachKeeper(
            id,
            options?.stdin === undefined
              ? { exec: [...argv] }
              : { exec: [...argv], stdin: true },
          );
          if (socket._tag === "None") {
            yield* warnNotStarted("Keeper did not start; running without it");
            return yield* execDirect(provider, id, argv, options);
          }
          const feederError = yield* Ref.make<StdinError | undefined>(
            undefined,
          );
          if (options?.stdin !== undefined) {
            const stdin = options.stdin;
            yield* Effect.forkScoped(
              Stream.runForEach(stdin, (chunk) =>
                writeFrame(
                  socket.value,
                  id.provider.name,
                  encodeInput({ in: Buffer.from(chunk).toString("base64") }),
                ),
              ).pipe(
                Effect.zipRight(
                  writeFrame(
                    socket.value,
                    id.provider.name,
                    encodeInput({ end: true }),
                  ),
                ),
                Effect.catchAll((error) =>
                  Effect.zipRight(
                    Ref.set(feederError, error),
                    Effect.sync(() => {
                      socket.value.destroy();
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
            socket.value,
            id.provider.name,
          ).pipe(
            Stream.mapEffect(
              (
                frame,
              ): Effect.Effect<ExecEvent, ProviderError | SandboxGoneError> => {
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
              socket.value,
              id.provider.name,
              encodeInput({ giveUp: true }),
            ).pipe(Effect.ignore),
          );
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      const stop = Effect.fn("KeeperClient.stop")(
        function* (rawId: string) {
          yield* stopKeeper(yield* resolveSandboxId(rawId, providers));
        },
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      // The Sandbox as the warm Keeper read it at connect, with no remote
      // call. With no Keeper up, the Provider reads it, as before the
      // Keeper did the checks; the command after starts the Keeper.
      const info = Effect.fn("KeeperClient.info")(
        function* (rawId: string) {
          const id = yield* resolveSandboxId(rawId, providers);
          const paths = yield* keeperPaths({
            provider: id.prefix,
            name: fileStem(id),
          });
          // No Keeper took the request: none answers, or one left before it
          // read it.
          const socket = yield* connectKeeper(
            paths.socket,
            id.provider.name,
          ).pipe(
            Effect.option,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (socket) =>
                  writeFrame(
                    socket,
                    id.provider.name,
                    encodeRequest({ info: true }),
                  ).pipe(
                    Effect.as(Option.some(socket)),
                    Effect.catchIf(
                      (error) => keeperAway(error),
                      () => Effect.succeedNone,
                    ),
                  ),
              }),
            ),
          );
          if (Option.isNone(socket)) {
            return yield* id.provider.get(id);
          }
          // The reader never ends before a last frame, so an empty reply
          // counts as a close.
          const reply = yield* readReplies(socket.value, id.provider.name).pipe(
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
            yield* stopKeeper(id);
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
