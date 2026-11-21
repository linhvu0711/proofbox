import { Effect } from "effect";
import { runAction } from "../pixel.ts";
import { Progress } from "../progress.ts";

export const pressKey = Effect.fn("key.pressKey")(function* (options: {
  readonly id: string;
  readonly keys: string;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly settle?: string | undefined;
}) {
  yield* runAction(options, {
    name: "key",
    args: (pace, shot) => [options.keys, String(pace.settleMs), shot],
    extraMs: (pace) => pace.settleMs,
  });
  const progress = yield* Progress;
  yield* progress.done(`pressed ${options.keys}`);
}, Effect.scoped);
