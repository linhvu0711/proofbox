import { createConnection, type Socket } from "node:net";
import { Effect, Schema, Stream } from "effect";
import { KeeperLostError, ProviderError } from "../errors.ts";
import { SandboxInfo } from "../provider.ts";

const Count = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

// A command to run, or a request for the Sandbox info the Keeper read at
// connect.
export const RequestFrame = Schema.Union(
  Schema.Struct({
    exec: Schema.Array(Schema.String),
    stdin: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({ info: Schema.Literal(true) }),
);
export type RequestFrame = typeof RequestFrame.Type;

export const ReplyFrame = Schema.Union(
  Schema.Struct({ out: Schema.String }),
  Schema.Struct({ err: Schema.String }),
  // `kills`: the memory-kill counts read before and after the command.
  Schema.Struct({
    exit: Schema.Number,
    kills: Schema.optional(Schema.Tuple(Count, Count)),
  }),
  Schema.Struct({ fail: Schema.String }),
  // The Sandbox is gone; the id is the one its Provider names it by.
  Schema.Struct({ gone: Schema.String }),
  Schema.Struct({ info: SandboxInfo }),
);
export type ReplyFrame = typeof ReplyFrame.Type;

// What the Caller sends after a command's request: its stdin, the end of
// it, or that it gives up waiting (the Keeper ends the command, ADR 0019).
export const InputFrame = Schema.Union(
  Schema.Struct({ in: Schema.String }),
  Schema.Struct({ end: Schema.Literal(true) }),
  Schema.Struct({ giveUp: Schema.Literal(true) }),
);
export type InputFrame = typeof InputFrame.Type;

export const encodeRequest = Schema.encodeSync(RequestFrame);
export const encodeReply = Schema.encodeSync(ReplyFrame);
export const decodeReply = Schema.decodeUnknownSync(ReplyFrame);
export const decodeRequest = Schema.decodeUnknownSync(RequestFrame);
export const encodeInput = Schema.encodeSync(InputFrame);
export const decodeInput = Schema.decodeUnknownSync(InputFrame);

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "";

// A connection to the Keeper socket at `socket`. A failure keeps the
// socket's code as its reason, so a Keeper that is not there is told apart.
export const connectKeeper = Effect.fn("protocol.connectKeeper")(function* (
  socket: string,
  provider: string,
) {
  return yield* Effect.async<Socket, ProviderError>((resume) => {
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
});

// One frame, one line. A failure keeps the socket's code as its reason, as
// connectKeeper does, so a Keeper that left before it read the request is
// told apart; the socket goes.
export const writeFrame = Effect.fn("protocol.writeFrame")(function* (
  socket: Socket,
  provider: string,
  frame: unknown,
) {
  return yield* Effect.async<void, ProviderError>((resume) => {
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
});

// The frames of one reply, as the Keeper sends them. An exit, fail, gone,
// or info frame is the last one: the stream ends after it, and reads no
// later line. A line that does not decode fails with its decode error; a
// socket that closes or breaks before the last frame fails as lost. The
// socket goes when the stream ends.
export const readReplies = (socket: Socket, provider: string) =>
  Stream.asyncPush<ReplyFrame, ProviderError | KeeperLostError>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let pending = "";
        let done = false;
        socket.on("data", (chunk) => {
          if (done) {
            return;
          }
          pending += chunk.toString("utf8");
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
            try {
              const frame = decodeReply(JSON.parse(line));
              emit.single(frame);
              if (!("out" in frame) && !("err" in frame)) {
                done = true;
                emit.end();
              }
            } catch (cause) {
              done = true;
              emit.fail(
                new ProviderError({
                  provider,
                  reason:
                    cause instanceof Error ? cause.message : String(cause),
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
            emit.fail(new KeeperLostError({}));
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
