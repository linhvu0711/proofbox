import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { Effect, Layer, Option, Ref, Schedule, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { withRunningPush } from "../deadline.ts";
import {
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

// The Caller side may send a stream whose failure is an upload error, not a
// ProviderError (packFiles can fail with UploadFailedError or
// WorkFileGrewError); when that stream feeds a real Connection.exec it is
// narrowed back to ProviderError.
type StdinError = ProviderError | UploadFailedError | WorkFileGrewError;

export interface KeeperExecOptions {
  readonly stdin?: Stream.Stream<Uint8Array, StdinError>;
}

export type KeeperExecError =
  | SandboxCallError
  | UploadFailedError
  | WorkFileGrewError;

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
  return events;
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
        Stream.asyncPush<ExecEvent, ProviderError | SandboxGoneError>((emit) =>
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
                    new ProviderError({
                      provider,
                      reason:
                        "Keeper closed the connection before the command exited",
                    }),
                  );
                }
              });
              socket.once("error", (error) => {
                if (!done) {
                  done = true;
                  emit.fail(
                    new ProviderError({ provider, reason: error.message }),
                  );
                }
              });
            }),
            () =>
              Effect.sync(() => {
                socket.destroy();
              }),
          ),
        );

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
        const socket = yield* connectSocket(
          paths.socket,
          id.provider.name,
        ).pipe(
          Effect.catchIf(
            (error) => RETRY_CODES.has(error.reason),
            () =>
              start(rawId).pipe(
                Effect.zipRight(connectSocket(paths.socket, id.provider.name)),
              ),
          ),
          Effect.option,
        );
        if (socket._tag === "None") {
          yield* output.err(
            "proofbox: Keeper did not start; running without it\n",
          );
          return yield* execDirect(provider, id, argv, options);
        }
        yield* writeLine(
          socket.value,
          id.provider.name,
          encodeRequest(
            options?.stdin === undefined
              ? { exec: [...argv] }
              : { exec: [...argv], stdin: true },
          ),
        );
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
                    fed === undefined
                      ? Stream.fail(frameError)
                      : Stream.fail(fed),
                ),
              ),
            ),
          ),
        );
        return events;
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
        Effect.async<ReplyFrame, ProviderError>((resume) => {
          let pending = "";
          let done = false;
          const finish = (result: Effect.Effect<ReplyFrame, ProviderError>) => {
            if (!done) {
              done = true;
              socket.destroy();
              resume(result);
            }
          };
          const fail = (reason: string) =>
            finish(Effect.fail(new ProviderError({ provider, reason })));
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
            fail("Keeper closed the connection before it answered"),
          );
          socket.once("error", (error) => fail(error.message));
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
        const socket = yield* connectSocket(
          paths.socket,
          id.provider.name,
        ).pipe(Effect.option);
        if (Option.isNone(socket)) {
          return yield* id.provider.get(id);
        }
        yield* writeLine(
          socket.value,
          id.provider.name,
          encodeRequest({ info: true }),
        );
        const reply = yield* oneReply(socket.value, id.provider.name);
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
