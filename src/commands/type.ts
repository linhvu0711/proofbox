import { Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";

export const typeText = (options: {
  readonly id: string;
  readonly text: string;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) =>
  Effect.gen(function* () {
    const pace = yield* resolvePace(options, options.text.length);
    const shot = options.screenshot === undefined ? "0" : "1";
    yield* runPixel(
      options.id,
      [
        "type",
        String(pace.letterMs),
        String(pace.settleMs),
        shot,
        options.text,
      ],
      { screenshot: options.screenshot },
    );
  }).pipe(Effect.scoped);
