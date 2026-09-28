import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { Effect, Layer, Schedule, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { ProviderError } from "../errors.ts";
import { type ExecEvent, Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";
import { spawnDetached } from "../spawn-detached.ts";
import { keeperPaths } from "./paths.ts";
import { decodeReply, encodeRequest } from "./protocol.ts";

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "";

const RETRY_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

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
        const id = yield* parseSandboxId(rawId, [...providers.keys()]);
        const paths = yield* keeperPaths(id);
        yield* spawnDetached(id.provider, "keeper/keeper-main", [
          `${id.provider}:${id.name}`,
        ]);
        yield* connectSocket(paths.socket, id.provider).pipe(
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

      const exec = (rawId: string, argv: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const id = yield* parseSandboxId(rawId, [...providers.keys()]);
          const provider = providers.get(id.provider);
          if (provider === undefined) {
            return yield* Effect.die(
              new Error(
                `Provider ${id.provider} passed parsing but is unknown`,
              ),
            );
          }
          const paths = yield* keeperPaths(id);
          const socket = yield* connectSocket(paths.socket, id.provider).pipe(
            Effect.catchIf(
              (error) => RETRY_CODES.has(error.reason),
              () =>
                start(rawId).pipe(
                  Effect.zipRight(connectSocket(paths.socket, id.provider)),
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
              .pipe(Effect.map((connection) => connection.exec(argv)));
          }
          yield* Effect.async<void, ProviderError>((resume) => {
            socket.value.write(
              `${JSON.stringify(encodeRequest({ exec: [...argv] }))}\n`,
              (error) =>
                resume(
                  error
                    ? Effect.fail(
                        new ProviderError({
                          provider: id.provider,
                          reason: error.message,
                        }),
                      )
                    : Effect.void,
                ),
            );
          });
          return frames(socket.value, id.provider);
        });

      const stop = Effect.fn("KeeperClient.stop")(function* (rawId: string) {
        const id = yield* parseSandboxId(rawId, [...providers.keys()]);
        const paths = yield* keeperPaths(id);
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
        exec: (rawId: string, argv: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const id = yield* parseSandboxId(rawId, [...providers.keys()]);
            const provider = providers.get(id.provider);
            if (provider === undefined) {
              return yield* Effect.die(new Error("unknown Provider"));
            }
            return yield* provider
              .connect(id.name)
              .pipe(Effect.map((connection) => connection.exec(argv)));
          }),
      });
    }),
  );
}
