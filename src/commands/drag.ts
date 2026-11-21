import { Effect } from "effect";
import { runAction } from "../pixel.ts";
import { Progress } from "../progress.ts";

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
  yield* runAction(options, {
    name: "drag",
    points: [
      [options.x1, options.y1],
      [options.x2, options.y2],
    ],
    args: (pace, shot) => [
      String(options.x1),
      String(options.y1),
      String(options.x2),
      String(options.y2),
      String(pace.glideMs),
      String(pace.settleMs),
      shot,
    ],
    // The pointer glides twice: to the start, then to the end.
    extraMs: (pace) => 2 * pace.glideMs + pace.settleMs,
  });
  const progress = yield* Progress;
  yield* progress.done(
    `dragged ${options.x1},${options.y1} to ${options.x2},${options.y2}`,
  );
}, Effect.scoped);
