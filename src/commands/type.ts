import { Duration, Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";
import { Progress } from "../progress.ts";

export const typeText = Effect.fn("type.typeText")(function* (options: {
  readonly id: string;
  readonly text: string;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) {
  const pace = yield* resolvePace(options, options.text.length);
  const shot = options.screenshot === undefined ? "0" : "1";
  yield* runPixel(
    options.id,
    ["type", String(pace.letterMs), String(pace.settleMs), shot, options.text],
    {
      screenshot: options.screenshot,
      limit: {
        _tag: "Act",
        name: "type",
        extra: Duration.millis(
          options.text.length * pace.letterMs + pace.settleMs,
        ),
      },
    },
  );
  const letters = Array.from(options.text).length;
  const progress = yield* Progress;
  yield* progress.done(
    `typed ${letters} ${letters === 1 ? "letter" : "letters"}`,
  );
}, Effect.scoped);
