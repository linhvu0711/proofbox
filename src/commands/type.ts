import { Effect } from "effect";
import { runAction } from "../pixel.ts";
import { Progress } from "../progress.ts";

export const typeText = Effect.fn("type.typeText")(function* (options: {
  readonly id: string;
  readonly text: string;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly mark?: string | undefined;
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) {
  yield* runAction(options, {
    name: "type",
    textLength: options.text.length,
    args: (pace, shot) => [
      String(pace.letterMs),
      String(pace.settleMs),
      shot,
      options.text,
    ],
    extraMs: (pace) => options.text.length * pace.letterMs + pace.settleMs,
  });
  const letters = Array.from(options.text).length;
  const progress = yield* Progress;
  yield* progress.done(
    `typed ${letters} ${letters === 1 ? "letter" : "letters"}`,
  );
}, Effect.scoped);
