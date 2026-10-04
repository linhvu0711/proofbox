import { text } from "node:stream/consumers";
import { Effect } from "effect";
import { ProviderError } from "../errors.ts";

export const readStdin = Effect.fn("stdin.readStdin")(() =>
  Effect.tryPromise({
    try: () => text(process.stdin),
    catch: (cause) =>
      new ProviderError({
        provider: "local",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  }),
);
