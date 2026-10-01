import { Duration, Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";

const BUTTONS = { left: "1", middle: "2", right: "3" } as const;

export const clickAt = Effect.fn("click.clickAt")(function* (options: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly button: keyof typeof BUTTONS;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) {
  const pace = yield* resolvePace(options);
  const shot = options.screenshot === undefined ? "0" : "1";
  yield* runPixel(
    options.id,
    [
      "click",
      String(options.x),
      String(options.y),
      BUTTONS[options.button],
      String(pace.glideMs),
      String(pace.settleMs),
      shot,
    ],
    {
      screenshot: options.screenshot,
      points: [[options.x, options.y]],
      limit: {
        _tag: "Act",
        name: "click",
        extra: Duration.millis(pace.glideMs + pace.settleMs),
      },
    },
  );
}, Effect.scoped);
