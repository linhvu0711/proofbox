import type { Socket } from "node:net";
import type { CommandExecutor } from "@effect/platform";
import {
  Clock,
  Data,
  Effect,
  Exit,
  Fiber,
  Mailbox,
  Runtime,
  Schedule,
  Stream,
} from "effect";
import { runCommand } from "../command-checks.ts";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";
import { Providers } from "../provider.ts";
import { fileStem, resolveSandboxId } from "../sandbox-id.ts";
import { programOf, writeKeeperLog } from "./keeper-log.ts";
import { holdKeeper, keeperAnswers } from "./lifecycle.ts";
import { keeperPaths } from "./paths.ts";
import { decodeInput, decodeRequest, encodeReply } from "./protocol.ts";

// The socket did not take a frame: the Caller is gone.
class SocketWriteError extends Data.TaggedError("SocketWriteError")<{
  readonly detail: string;
}> {
  get message() {
    return this.detail;
  }
}

// The first line from a Caller is not a request the Keeper knows.
class BadRequestError extends Data.TaggedError("BadRequestError") {
  get message() {
    return "bad request";
  }
}

const writeFrame = (socket: Socket, frame: unknown) =>
  Effect.async<void, SocketWriteError>((resume) => {
    socket.write(`${JSON.stringify(frame)}\n`, (error) =>
      resume(
        error
          ? Effect.fail(new SocketWriteError({ detail: error.message }))
          : Effect.void,
      ),
    );
  });

const frameOf = (event: ExecEvent) => {
  switch (event._tag) {
    case "Stdout":
      return { out: Buffer.from(event.bytes).toString("base64") };
    case "Stderr":
      return { err: Buffer.from(event.bytes).toString("base64") };
    case "Exit":
      return event.kills === undefined
        ? { exit: event.code }
        : {
            exit: event.code,
            kills: [event.kills.before, event.kills.after],
          };
  }
};

// The client wraps the text in its own ProviderError, so a ProviderError
// sends only its reason.
const failText = (error: unknown) =>
  error instanceof ProviderError
    ? error.reason
    : error instanceof Error
      ? error.message
      : String(error);

// What kind of error ended a command, for the Keeper log: its tag, never
// its text.
const errorKind = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string"
    ? error._tag
    : "unknown";

export const runKeeper = Effect.fn("keeper.runKeeper")(function* (
  rawId: string,
) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const provider = id.provider;
  const paths = yield* keeperPaths({
    provider: id.prefix,
    name: fileStem(id),
  });
  if (yield* keeperAnswers(paths.socket)) {
    return;
  }

  const serve = Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* provider.connect(id);
      const runtime = yield* Effect.runtime<CommandExecutor.CommandExecutor>();
      const handleClient = (socket: Socket) => {
        let pending = "";
        // The lines in hand: a Caller that gives up writes its give-up
        // frame and closes at once, so the close waits for that frame.
        let handling: Promise<unknown> = Promise.resolve();
        // "request": waiting for the request line; "plain": no stdin, the
        // exec runs inside the line handler; "stdin": a Mailbox feeds the
        // exec's stdin from the lines that follow.
        let mode: "request" | "plain" | "stdin" = "request";
        let mailbox: Mailbox.Mailbox<Uint8Array, ProviderError> | undefined;
        let inputEnded = false;
        let execDone = false;
        let closeSocket = false;
        // The command's own fiber, so a Caller who leaves or gives up ends
        // it, and with it the ssh or docker exec and the Deadline push.
        let running: Fiber.RuntimeFiber<void> | undefined;
        let execEnded = false;
        // How an ended command ended, for the Keeper log: set only when the
        // Caller ends it.
        let ending: "gave up" | "Caller left" | undefined;
        const endExec = (why: "gave up" | "Caller left") => {
          // The first reason wins: a Caller that gave up also closes.
          if (running !== undefined && !execEnded && ending === undefined) {
            ending = why;
            void Runtime.runPromiseExit(runtime)(Fiber.interrupt(running));
          }
        };

        const runExec = (
          argv: ReadonlyArray<string>,
          options?: ExecOptions,
        ) => {
          const tally = {
            out: 0,
            err: 0,
            exit: undefined as number | undefined,
            firstMs: undefined as number | undefined,
          };
          let logged = false;
          const log = (start: number, ended: string) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) => {
              if (logged) {
                return Effect.void;
              }
              logged = true;
              return writeKeeperLog(paths.log, {
                at: new Date(now),
                kind: "exec",
                program: programOf(argv),
                ...tally,
                tookMs: now - start,
                ended,
              });
            });
          return Effect.flatMap(Clock.currentTimeMillis, (start) =>
            runCommand(connection, argv, options).pipe(
              Stream.runForEach((event) => {
                if (event._tag !== "Exit") {
                  if (event._tag === "Stdout") {
                    tally.out += event.bytes.length;
                  } else {
                    tally.err += event.bytes.length;
                  }
                  const send = writeFrame(socket, frameOf(event));
                  // An empty chunk carries no byte, so it is not the first.
                  return tally.firstMs === undefined && event.bytes.length > 0
                    ? Effect.flatMap(Clock.currentTimeMillis, (now) => {
                        tally.firstMs = now - start;
                        return send;
                      })
                    : send;
                }
                // The Caller may close as soon as it reads the exit, so the
                // command counts as ended, and is logged, before it goes.
                tally.exit = event.code;
                execEnded = true;
                return log(start, "done").pipe(
                  Effect.zipRight(writeFrame(socket, frameOf(event))),
                );
              }),
              Effect.as("done"),
              // Logged before the error goes out, as the exit is. The log
              // takes only the error's kind: its text can hold the command
              // line (ADR 0019).
              Effect.catchAll((error) => {
                const ended =
                  error instanceof SandboxGoneError
                    ? "gone"
                    : `error: ${errorKind(error)}`;
                return log(start, ended).pipe(
                  Effect.zipRight(
                    writeFrame(
                      socket,
                      error instanceof SandboxGoneError
                        ? { gone: error.id }
                        : { fail: failText(error) },
                    ),
                  ),
                  Effect.orElseSucceed(() => undefined),
                  Effect.as(ended),
                );
              }),
              Effect.onExit((exit) =>
                log(
                  start,
                  ending ?? (Exit.isSuccess(exit) ? exit.value : "Caller left"),
                ),
              ),
              Effect.asVoid,
              Effect.ensuring(
                Effect.sync(() => {
                  execEnded = true;
                  // A command may exit before its input ends (tar -x
                  // stops at the end-of-archive marker); drain the
                  // remaining input frames so the client can finish
                  // writing before the socket closes. Shutting the
                  // Mailbox down wakes an offer parked on a full one and
                  // drops input no one will read; `end` would leave that
                  // offer parked until a take that never comes.
                  if (mode === "stdin" && !inputEnded) {
                    execDone = true;
                    void Runtime.runPromiseExit(runtime)(
                      mailbox === undefined ? Effect.void : mailbox.shutdown,
                    );
                  } else {
                    socket.end();
                    socket.destroy();
                  }
                }),
              ),
            ),
          );
        };

        const failInput = (reason: string) =>
          mailbox === undefined || inputEnded
            ? Effect.void
            : Effect.asVoid(
                mailbox.fail(
                  new ProviderError({ provider: id.provider.name, reason }),
                ),
              );

        const handleLine = Effect.fn("keeper.handleLine")(function* (
          line: string,
        ) {
          if (mode === "request") {
            const request = yield* Effect.try({
              try: () => decodeRequest(JSON.parse(line)),
              catch: () => new BadRequestError(),
            });
            if ("info" in request) {
              mode = "plain";
              closeSocket = true;
              yield* writeFrame(socket, encodeReply({ info: connection.info }));
              const now = yield* Clock.currentTimeMillis;
              yield* writeKeeperLog(paths.log, {
                at: new Date(now),
                kind: "info",
                program: "-",
                out: 0,
                err: 0,
                exit: undefined,
                firstMs: undefined,
                tookMs: 0,
                ended: "done",
              });
            } else if (request.stdin === true) {
              mode = "stdin";
              mailbox = yield* Mailbox.make<Uint8Array, ProviderError>(16);
              // forkDaemon: the exec must outlive this line-handler fiber
              // (a plain fork would be interrupted when the handler ends).
              running = yield* Effect.forkDaemon(
                runExec(request.exec, {
                  stdin: Mailbox.toStream(mailbox),
                }),
              );
            } else {
              mode = "plain";
              // Forked as stdin mode is, so the socket keeps reading while
              // the command runs and sees the Caller leave.
              running = yield* Effect.forkDaemon(runExec(request.exec));
            }
          } else if (mode === "plain") {
            // Only a give-up frame means anything after a plain request.
            const frame = yield* Effect.option(
              Effect.try(() => decodeInput(JSON.parse(line))),
            );
            if (frame._tag === "Some" && "giveUp" in frame.value) {
              endExec("gave up");
            }
          } else if (mode === "stdin" && mailbox !== undefined) {
            const frame = yield* Effect.try({
              try: () => decodeInput(JSON.parse(line)),
              catch: () =>
                new ProviderError({
                  provider: id.provider.name,
                  reason: "bad input frame",
                }),
            });
            // A give-up frame counts even after the input ended: a build
            // sends its whole script, then runs.
            if ("giveUp" in frame) {
              endExec("gave up");
            } else if (inputEnded) {
              // The input is over; later input frames mean nothing.
            } else if ("in" in frame) {
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
          handling = Runtime.runPromiseExit(runtime)(
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
                  if (closeSocket) {
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
          void handling.then(() => {
            endExec("Caller left");
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
        });
      };
      const started = yield* holdKeeper(id, handleClient);
      if (!started) {
        return;
      }
      // The gone-watch reads over the Keeper's own link, first one interval
      // after the Keeper serves: connect has just read the Sandbox. A gone
      // Sandbox fails it and ends the Keeper.
      yield* Effect.schedule(connection.get, Schedule.spaced("2 seconds"));
    }),
  );

  yield* serve;
});
