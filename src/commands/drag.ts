import { Duration, Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";

export const dragFrom = Effect.fn("drag.dragFrom")(function* (options: {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly settle?: string | undefined;
}) {
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
      // The pointer glides twice: to the start, then to the end.
      limit: {
        _tag: "Act",
        name: "drag",
        extra: Duration.millis(2 * pace.glideMs + pace.settleMs),
      },
    },
  );
}, Effect.scoped);
