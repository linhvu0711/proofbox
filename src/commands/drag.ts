import { Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";

export const dragFrom = (options: {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) =>
  Effect.gen(function* () {
    const pace = yield* resolvePace(options);
    const shot = options.screenshot === undefined ? "0" : "1";
    yield* runPixel(
      options.id,
      [
        "drag",
        String(options.x1),
        String(options.y1),
        String(options.x2),
        String(options.y2),
        String(pace.glideMs),
        String(pace.settleMs),
        shot,
      ],
      {
        screenshot: options.screenshot,
        points: [
          [options.x1, options.y1],
          [options.x2, options.y2],
        ],
      },
    );
  }).pipe(Effect.scoped);
