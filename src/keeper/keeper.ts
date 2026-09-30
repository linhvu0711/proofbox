import { rm, writeFile } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { CommandExecutor } from "@effect/platform";
import { Effect, Mailbox, Runtime, Schedule, Stream } from "effect";
import { ProviderError } from "../errors.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";
import { Providers } from "../provider.ts";
import { fileStem, resolveSandboxId } from "../sandbox-id.ts";
import { keeperPaths } from "./paths.ts";
import { decodeInput, decodeRequest } from "./protocol.ts";

const socketAnswers = (path: string) =>
  Effect.async<boolean>((resume) => {
    const probe = createConnection({ path }, () => {
      probe.destroy();
      resume(Effect.succeed(true));
    });
    probe.once("error", () => {
      probe.destroy();
      resume(Effect.succeed(false));
    });
  });

const writeFrame = (socket: Socket, frame: unknown) =>
  Effect.async<void, Error>((resume) => {
    socket.write(`${JSON.stringify(frame)}\n`, (error) =>
      resume(error ? Effect.fail(error) : Effect.void),
    );
  });

const frameOf = (event: ExecEvent) => {
  switch (event._tag) {
    case "Stdout":
      return { out: Buffer.from(event.bytes).toString("base64") };
    case "Stderr":
      return { err: Buffer.from(event.bytes).toString("base64") };
    case "Exit":
      return { exit: event.code };
  }
};

export const runKeeper = (rawId: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const paths = yield* keeperPaths({
      provider: id.prefix,
      name: fileStem(id),
    });
    if (yield* socketAnswers(paths.socket)) {
      return;
    }
    yield* Effect.promise(() =>
      rm(paths.socket, { force: true }).catch(() => {}),
    );

    const serve = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* provider.connect(id);
        const runtime =
          yield* Effect.runtime<CommandExecutor.CommandExecutor>();
        const handleClient = (socket: Socket) => {
          let pending = "";
          // "request": waiting for the request line; "plain": no stdin, the
          // exec runs inside the line handler; "stdin": a Mailbox feeds the
          // exec's stdin from the lines that follow.
          let mode: "request" | "plain" | "stdin" = "request";
          let mailbox: Mailbox.Mailbox<Uint8Array, ProviderError> | undefined;
          let inputEnded = false;
          let execDone = false;
          let closeSocket = false;

          const runExec = (
            argv: ReadonlyArray<string>,
            options?: ExecOptions,
          ) =>
            connection
              .exec(argv, options)
              .pipe(
                Stream.runForEach((event) =>
                  writeFrame(socket, frameOf(event)),
                ),
              )
              .pipe(
                Effect.catchAll((error) =>
                  writeFrame(socket, {
                    fail:
                      error instanceof Error ? error.message : String(error),
                  }).pipe(Effect.orElseSucceed(() => undefined)),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    // A command may exit before its input ends (tar -x
                    // stops at the end-of-archive marker); drain the
                    // remaining input frames so the client can finish
                    // writing before the socket closes. Ending the
                    // Mailbox wakes an offer parked on a full one.
                    if (mode === "stdin" && !inputEnded) {
                      execDone = true;
                      void Runtime.runPromiseExit(runtime)(
                        mailbox === undefined ? Effect.void : mailbox.end,
                      );
                    } else {
                      socket.end();
                      socket.destroy();
                    }
                  }),
                ),
              );

          const failInput = (reason: string) =>
            mailbox === undefined || inputEnded
              ? Effect.void
              : Effect.asVoid(
                  mailbox.fail(
                    new ProviderError({ provider: id.provider.name, reason }),
                  ),
                );

          const handleLine = (line: string) =>
            Effect.gen(function* () {
              if (mode === "request") {
                const request = yield* Effect.try({
                  try: () => decodeRequest(JSON.parse(line)),
                  catch: () => new Error("bad request"),
                });
                if (request.stdin === true) {
                  mode = "stdin";
                  mailbox = yield* Mailbox.make<Uint8Array, ProviderError>(16);
                  // forkDaemon: the exec must outlive this line-handler fiber
                  // (a plain fork would be interrupted when the handler ends).
                  yield* Effect.forkDaemon(
                    runExec(request.exec, {
                      stdin: Mailbox.toStream(mailbox),
                    }),
                  );
                } else {
                  mode = "plain";
                  yield* runExec(request.exec);
                }
              } else if (
                mode === "stdin" &&
                mailbox !== undefined &&
                !inputEnded
              ) {
                const frame = yield* Effect.try({
                  try: () => decodeInput(JSON.parse(line)),
                  catch: () =>
                    new ProviderError({
                      provider: id.provider.name,
                      reason: "bad input frame",
                    }),
                });
                if ("in" in frame) {
                  if (!execDone) {
                    yield* mailbox.offer(
                      new Uint8Array(Buffer.from(frame.in, "base64")),
                    );
                  }
                } else {
                  inputEnded = true;
                  if (execDone) {
                    closeSocket = true;
                  } else {
                    yield* mailbox.end;
                  }
                }
              }
            });

          socket.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            socket.pause();
            void Runtime.runPromiseExit(runtime)(
              Effect.gen(function* () {
                let newline = pending.indexOf("\n");
                while (newline !== -1) {
                  const line = pending.slice(0, newline);
                  pending = pending.slice(newline + 1);
                  newline = pending.indexOf("\n");
                  yield* handleLine(line);
                }
              }).pipe(
                Effect.catchAll((error) =>
                  (mode === "stdin"
                    ? failInput(
                        error instanceof Error ? error.message : String(error),
                      )
                    : Effect.andThen(
                        Effect.sync(() => {
                          closeSocket = true;
                        }),
                        writeFrame(socket, {
                          fail:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        }),
                      )
                  ).pipe(Effect.orElseSucceed(() => undefined)),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (mode === "plain" || closeSocket) {
                      socket.end();
                      socket.destroy();
                    } else {
                      socket.resume();
                    }
                  }),
                ),
              ),
            );
          });

          socket.once("close", () => {
            if (mailbox !== undefined && !inputEnded) {
              inputEnded = true;
              void Runtime.runPromiseExit(runtime)(
                mailbox.fail(
                  new ProviderError({
                    provider: id.provider.name,
                    reason:
                      "the client closed the connection before the input ended",
                  }),
                ),
              );
            }
          });
        };
        yield* Effect.acquireRelease(
          Effect.async<Server, ProviderError>((resume) => {
            const server = createServer(handleClient);
            server.once("error", (error) =>
              resume(
                Effect.fail(
                  new ProviderError({
                    provider: id.provider.name,
                    reason: error.message,
                  }),
                ),
              ),
            );
            server.listen(paths.socket, () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.promise(
              () => new Promise<void>((done) => server.close(() => done())),
            ),
        );
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => writeFile(paths.pid, `${process.pid}\n`),
            catch: (cause) =>
              new ProviderError({
                provider: id.provider.name,
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
          () =>
            Effect.promise(() =>
              Promise.all([
                rm(paths.socket, { force: true }).catch(() => {}),
                rm(paths.pid, { force: true }).catch(() => {}),
              ]).then(() => {}),
            ),
        );
        yield* Effect.never;
      }),
    );

    const watchGone = Effect.repeat(
      provider.get(id),
      Schedule.spaced("2 seconds"),
    ).pipe(Effect.asVoid);

    yield* Effect.raceFirst(serve, watchGone);
  });
