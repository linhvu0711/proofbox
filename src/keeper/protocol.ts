import { Schema } from "effect";

export const RequestFrame = Schema.Struct({
  exec: Schema.Array(Schema.String),
  stdin: Schema.optional(Schema.Literal(true)),
});
export type RequestFrame = typeof RequestFrame.Type;

export const ReplyFrame = Schema.Union(
  Schema.Struct({ out: Schema.String }),
  Schema.Struct({ err: Schema.String }),
  Schema.Struct({ exit: Schema.Number }),
  Schema.Struct({ fail: Schema.String }),
);
export type ReplyFrame = typeof ReplyFrame.Type;

export const InputFrame = Schema.Union(
  Schema.Struct({ in: Schema.String }),
  Schema.Struct({ end: Schema.Literal(true) }),
);
export type InputFrame = typeof InputFrame.Type;

export const encodeRequest = Schema.encodeSync(RequestFrame);
export const decodeReply = Schema.decodeUnknownSync(ReplyFrame);
export const decodeRequest = Schema.decodeUnknownSync(RequestFrame);
export const encodeInput = Schema.encodeSync(InputFrame);
export const decodeInput = Schema.decodeUnknownSync(InputFrame);
