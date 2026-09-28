import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { Effect, Layer, Ref, Schedule, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  ProviderError,
  type ProviderUnavailableError,
  type UploadFailedError,
} from "../errors.ts";
import { type ExecEvent, type ExecOptions, Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";
import { spawnDetached } from "../spawn-detached.ts";
import { keeperPaths } from "./paths.ts";
import { decodeReply, encodeInput, encodeRequest } from "./protocol.ts";

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "";

const RETRY_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

// The Caller side may send a stream whose failure is an upload error, not a
// ProviderError (packFiles can fail with UploadFailedError); when that stream
// feeds a real Connection.exec it is narrowed back to ProviderError.
export interface KeeperExecOptions {
  readonly stdin?: Stream.Stream<Uint8Array, ProviderError | UploadFailedError>;
}

export type KeeperExecError =
  | ProviderError
  | ProviderUnavailableError
  | UploadFailedError;

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
          name: id.name,
        });
        yield* spawnDetached(id.provider.name, "keeper/keeper-main", [
          `${id.prefix}:${id.name}`,
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
        Stream.asyncPush<ExecEvent, ProviderError>((emit) =>
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
                      emit.single({ _tag: "Exit", code: frame.exit });
                      done = true;
                      emit.end();
                    } else {
                      done = true;
                      emit.fail(
                        new ProviderError({ provider, reason: frame.fail }),
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

      const exec = (
        rawId: string,
        argv: ReadonlyArray<string>,
        options?: KeeperExecOptions,
      ) =>
        Effect.gen(function* () {
          const id = yield* resolveSandboxId(rawId, providers);
          const provider = id.provider;
          const paths = yield* keeperPaths({
            provider: id.prefix,
            name: id.name,
          });
          const socket = yield* connectSocket(
            paths.socket,
            id.provider.name,
          ).pipe(
            Effect.catchIf(
              (error) => RETRY_CODES.has(error.reason),
              () =>
                start(rawId).pipe(
                  Effect.zipRight(
                    connectSocket(paths.socket, id.provider.name),
                  ),
                ),
            ),
            Effect.option,
          );
          if (socket._tag === "None") {
            yield* output.err(
              "proofbox: Keeper did not start; running without it\n",
            );
            return yield* provider
              .connect(id.name)
              .pipe(
                Effect.map(
                  (connection): Stream.Stream<ExecEvent, KeeperExecError> =>
                    connection.exec(argv, narrowStdin(options)),
                ),
              );
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
          const feederError = yield* Ref.make<
            ProviderError | UploadFailedError | undefined
          >(undefined);
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
                  Effect.map((fed) =>
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
          name: id.name,
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

      return { start, exec, stop };
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
        exec: (
          rawId: string,
          argv: ReadonlyArray<string>,
          options?: KeeperExecOptions,
        ) =>
          Effect.gen(function* () {
            const id = yield* resolveSandboxId(rawId, providers);
            const provider = id.provider;
            return yield* provider
              .connect(id.name)
              .pipe(
                Effect.map(
                  (connection): Stream.Stream<ExecEvent, KeeperExecError> =>
                    connection.exec(argv, narrowStdin(options)),
                ),
              );
          }),
      });
    }),
  );
}
