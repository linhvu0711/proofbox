import { Schema } from "effect";
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
