import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { CliOutput } from "../cli-output.ts";
import { withRunningPush } from "../deadline.ts";
import {
  AnswerTimeoutError,
  ProviderError,
  SandboxGoneError,
  type UploadFailedError,
  type WorkFileGrewError,
} from "../errors.ts";
import {
  type ExecEvent,
  type ExecOptions,
  type Provider,
  Providers,
  type SandboxCallError,
  type SandboxRef,
} from "../provider.ts";
import { fileStem, formatSandboxId, resolveSandboxId } from "../sandbox-id.ts";
import { spawnDetached } from "../spawn-detached.ts";
import { keeperPaths } from "./paths.ts";
import {
  decodeReply,
  encodeInput,
  encodeRequest,
  type ReplyFrame,
} from "./protocol.ts";

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "";

const RETRY_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

// No Keeper answers: none is there, or one left before it read the
// request, as a Keeper does when its Sandbox is gone.
const KEEPER_AWAY = new Set([...RETRY_CODES, "EPIPE", "ECONNRESET"]);

// The Keeper closed or broke the connection before its last frame. It may
// have read the request, so the request never goes again.
class KeeperLostError extends Data.TaggedError("KeeperLostError")<{
  readonly reason: string;
}> {}

// The Sandbox as the Provider reads it once the Keeper is lost: a gone
// Sandbox fails gone, and any other failure keeps the lost reason.
const readAfterLost = Effect.fn("keeperClient.readAfterLost")(function* (
  provider: Provider,
  sandbox: SandboxRef,
  lost: KeeperLostError,
) {
  return yield* Effect.catchIf(
    provider.get(sandbox),
    (error) => !(error instanceof SandboxGoneError),
    () =>
      Effect.fail(
        new ProviderError({ provider: provider.name, reason: lost.reason }),
      ),
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

// Without a Keeper the stdin stream feeds Connection.exec, which narrows its
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
  const events: Stream.Stream<ExecEvent, KeeperExecError> = withRunningPush(
    connection,
  )(connection.exec(argv, narrowStdin(fed))).pipe(
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
      const output = yield* CliOutput;

      const connectSocket = (socket: string, provider: string) =>
        Effect.async<Socket, ProviderError>((resume) => {
          const s = createConnection({ path: socket }, () =>
            resume(Effect.succeed(s)),
          );
          s.once("error", (error) => {
            s.destroy();
            resume(
              Effect.fail(
                new ProviderError({
                  provider,
                  reason: codeOf(error) || error.message,
                }),
              ),
            );
          });
        });

      const start = Effect.fn("KeeperClient.start")(function* (rawId: string) {
        const id = yield* resolveSandboxId(rawId, providers);
        const paths = yield* keeperPaths({
          provider: id.prefix,
          name: fileStem(id),
        });
        yield* spawnDetached(id.provider.name, "keeper/keeper-main", [
          formatSandboxId({
            provider: id.prefix,
            region: id.region,
            name: id.name,
          }),
        ]);
        yield* connectSocket(paths.socket, id.provider.name).pipe(
          Effect.retry({
            while: (error) => RETRY_CODES.has(error.reason),
            schedule: Schedule.spaced("50 millis").pipe(
              Schedule.upTo("10 seconds"),
            ),
          }),
          Effect.tap((socket) => Effect.sync(() => socket.destroy())),
        );
      });

      const frames = (socket: Socket, provider: string) =>
        Stream.asyncPush<
          ExecEvent,
          ProviderError | SandboxGoneError | KeeperLostError
        >((emit) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              let pending = "";
              let done = false;
              socket.on("data", (chunk) => {
                pending += chunk.toString("utf8");
                let newline = pending.indexOf("\n");
                while (newline !== -1) {
                  const line = pending.slice(0, newline);
                  pending = pending.slice(newline + 1);
                  newline = pending.indexOf("\n");
                  try {
                    const frame = decodeReply(JSON.parse(line));
                    if ("out" in frame) {
                      emit.single({
                        _tag: "Stdout",
                        bytes: new Uint8Array(Buffer.from(frame.out, "base64")),
                      });
                    } else if ("err" in frame) {
                      emit.single({
                        _tag: "Stderr",
                        bytes: new Uint8Array(Buffer.from(frame.err, "base64")),
                      });
                    } else if ("exit" in frame) {
                      emit.single(
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
                      done = true;
                      emit.end();
                    } else if ("gone" in frame) {
                      done = true;
                      emit.fail(new SandboxGoneError({ id: frame.gone }));
                    } else {
                      done = true;
                      emit.fail(
                        new ProviderError({
                          provider,
                          reason:
                            "fail" in frame
                              ? frame.fail
                              : "the Keeper sent Sandbox info for a command",
                        }),
                      );
                    }
                  } catch (cause) {
                    done = true;
                    emit.fail(
                      new ProviderError({
                        provider,
                        reason:
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                      }),
                    );
                  }
                  if (done) {
                    return;
                  }
                }
              });
              socket.once("close", () => {
                if (!done) {
                  done = true;
                  emit.fail(
                    new KeeperLostError({
                      reason:
                        "Keeper closed the connection before the command exited",
                    }),
                  );
                }
              });
              socket.once("error", (error) => {
                if (!done) {
                  done = true;
                  emit.fail(new KeeperLostError({ reason: error.message }));
                }
              });
            }),
            () =>
              Effect.sync(() => {
                socket.destroy();
              }),
          ),
        );

      // The request, the first line to a Keeper. A failure keeps the
      // socket's code as its reason, as connectSocket does, so a Keeper that
      // left before it read the request is told apart; the socket goes.
      const writeRequest = (socket: Socket, provider: string, frame: unknown) =>
        Effect.async<void, ProviderError>((resume) => {
          socket.write(`${JSON.stringify(frame)}\n`, (error) => {
            if (error) {
              socket.destroy();
            }
            resume(
              error
                ? Effect.fail(
                    new ProviderError({
                      provider,
                      reason: codeOf(error) || error.message,
                    }),
                  )
                : Effect.void,
            );
          });
        });

      const writeLine = (socket: Socket, provider: string, frame: unknown) =>
        Effect.async<void, ProviderError>((resume) => {
          socket.write(`${JSON.stringify(frame)}\n`, (error) =>
            resume(
              error
                ? Effect.fail(
                    new ProviderError({
                      provider,
                      reason: error.message,
                    }),
                  )
                : Effect.void,
            ),
          );
        });

      const exec = Effect.fn("KeeperClient.exec")(function* (
        rawId: string,
        argv: ReadonlyArray<string>,
        options?: KeeperExecOptions,
      ) {
        const id = yield* resolveSandboxId(rawId, providers);
        const provider = id.provider;
        const paths = yield* keeperPaths({
          provider: id.prefix,
          name: fileStem(id),
        });
        // The Keeper never read a request it dropped, so after a new Keeper
        // starts the request goes again.
        const connect = connectSocket(paths.socket, id.provider.name).pipe(
          Effect.tap((socket) =>
            writeRequest(
              socket,
              id.provider.name,
              encodeRequest(
                options?.stdin === undefined
                  ? { exec: [...argv] }
                  : { exec: [...argv], stdin: true },
              ),
            ),
          ),
        );
        // With no Keeper, the Provider says first whether the Sandbox is
        // still there: a gone one fails here, with no Keeper started for it.
        const socket = yield* connect.pipe(
          Effect.map(Option.some),
          Effect.catchAll((error) =>
            KEEPER_AWAY.has(error.reason)
              ? Effect.zipRight(
                  provider.get(id),
                  Effect.option(Effect.zipRight(start(rawId), connect)),
                )
              : Effect.succeed(Option.none<Socket>()),
          ),
        );
        if (socket._tag === "None") {
          yield* output.err(
            "proofbox: Keeper did not start; running without it\n",
          );
          return yield* execDirect(provider, id, argv, options);
        }
        const feederError = yield* Ref.make<StdinError | undefined>(undefined);
        if (options?.stdin !== undefined) {
          const stdin = options.stdin;
          yield* Effect.forkScoped(
            Stream.runForEach(stdin, (chunk) =>
              writeLine(
                socket.value,
                id.provider.name,
                encodeInput({ in: Buffer.from(chunk).toString("base64") }),
              ),
            ).pipe(
              Effect.zipRight(
                writeLine(
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
        const events: Stream.Stream<ExecEvent, KeeperExecError> = frames(
          socket.value,
          id.provider.name,
        ).pipe(
          Stream.catchAll((frameError) =>
            Stream.unwrap(
              Ref.get(feederError).pipe(
                Effect.map(
                  (fed): Stream.Stream<never, KeeperExecError> =>
                    fed !== undefined
                      ? Stream.fail(fed)
                      : frameError instanceof KeeperLostError
                        ? Stream.fromEffect(
                            Effect.flatMap(
                              readAfterLost(provider, id, frameError),
                              () =>
                                Effect.fail(
                                  new ProviderError({
                                    provider: provider.name,
                                    reason: frameError.reason,
                                  }),
                                ),
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
          writeLine(
            socket.value,
            id.provider.name,
            encodeInput({ giveUp: true }),
          ).pipe(Effect.ignore),
        );
      });

      const stop = Effect.fn("KeeperClient.stop")(function* (rawId: string) {
        const id = yield* resolveSandboxId(rawId, providers);
        const paths = yield* keeperPaths({
          provider: id.prefix,
          name: fileStem(id),
        });
        const pidText = yield* Effect.promise(() =>
          readFile(paths.pid, "utf8").catch(() => ""),
        );
        const pid = Number.parseInt(pidText.trim(), 10);
        if (Number.isFinite(pid)) {
          // A stale pid file can name a reused, unrelated pid; only signal a
          // process that still runs keeper-main.
          const isKeeper = yield* Effect.promise(() =>
            promisify(execFile)("ps", ["-p", String(pid), "-o", "command="])
              .then(({ stdout }) => stdout.includes("keeper-main"))
              .catch(() => false),
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
        yield* Effect.promise(() =>
          Promise.all([
            rm(paths.socket, { force: true }).catch(() => {}),
            rm(paths.pid, { force: true }).catch(() => {}),
          ]).then(() => {}),
        );
      });

      // The one reply to a request that is not a command.
      const oneReply = (socket: Socket, provider: string) =>
        Effect.async<ReplyFrame, ProviderError | KeeperLostError>((resume) => {
          let pending = "";
          let done = false;
          const finish = (
            result: Effect.Effect<ReplyFrame, ProviderError | KeeperLostError>,
          ) => {
            if (!done) {
              done = true;
              socket.destroy();
              resume(result);
            }
          };
          const fail = (reason: string) =>
            finish(Effect.fail(new ProviderError({ provider, reason })));
          const lost = (reason: string) =>
            finish(Effect.fail(new KeeperLostError({ reason })));
          socket.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            const newline = pending.indexOf("\n");
            if (newline === -1) {
              return;
            }
            try {
              finish(
                Effect.succeed(
                  decodeReply(JSON.parse(pending.slice(0, newline))),
                ),
              );
            } catch (cause) {
              fail(cause instanceof Error ? cause.message : String(cause));
            }
          });
          socket.once("close", () =>
            lost("Keeper closed the connection before it answered"),
          );
          socket.once("error", (error) => lost(error.message));
        });

      // The Sandbox as the warm Keeper read it at connect, with no remote
      // call. With no Keeper up, the Provider reads it, as before the
      // Keeper did the checks; the command after starts the Keeper.
      const info = Effect.fn("KeeperClient.info")(function* (rawId: string) {
        const id = yield* resolveSandboxId(rawId, providers);
        const paths = yield* keeperPaths({
          provider: id.prefix,
          name: fileStem(id),
        });
        // No Keeper took the request: none answers, or one left before it
        // read it.
        const socket = yield* connectSocket(
          paths.socket,
          id.provider.name,
        ).pipe(
          Effect.option,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (socket) =>
                writeRequest(
                  socket,
                  id.provider.name,
                  encodeRequest({ info: true }),
                ).pipe(
                  Effect.as(Option.some(socket)),
                  Effect.catchIf(
                    (error) => KEEPER_AWAY.has(error.reason),
                    () => Effect.succeedNone,
                  ),
                ),
            }),
          ),
        );
        if (Option.isNone(socket)) {
          return yield* id.provider.get(id);
        }
        const reply = yield* oneReply(socket.value, id.provider.name).pipe(
          Effect.catchTag("KeeperLostError", (lost) =>
            Effect.map(readAfterLost(id.provider, id, lost), (info) => ({
              info,
            })),
          ),
        );
        if ("info" in reply) {
          return reply.info;
        }
        // A Keeper from an older build cannot read the request and would
        // run commands with no Deadline push: stop it, so the next command
        // starts a new one.
        if ("fail" in reply && reply.fail === "bad request") {
          yield* stop(rawId);
          return yield* id.provider.get(id);
        }
        return yield* new ProviderError({
          provider: id.provider.name,
          reason:
            "fail" in reply ? reply.fail : "the Keeper sent no Sandbox info",
        });
      });

      return { start, exec, info, stop };
    }),
  },
) {
  static Direct = Layer.effect(
    KeeperClient,
    Effect.gen(function* () {
      const providers = yield* Providers;
      return new KeeperClient({
        start: () => Effect.void,
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
