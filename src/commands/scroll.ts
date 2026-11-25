import { Effect } from "effect";
import { BadStepsError } from "../errors.ts";
import { runAction } from "../pixel.ts";
import { Progress } from "../progress.ts";

const BUTTONS = { up: "4", down: "5", left: "6", right: "7" } as const;

export const scrollAt = Effect.fn("scroll.scrollAt")(function* (options: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly direction: keyof typeof BUTTONS;
  readonly steps: number;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly mark?: string | undefined;
  readonly glide?: string | undefined;
  readonly settle?: string | undefined;
}) {
  if (options.steps < 1) {
    return yield* new BadStepsError({ steps: options.steps });
  }
  yield* runAction(options, {
    name: "scroll",
    points: [[options.x, options.y]],
    args: (pace, shot) => [
      String(options.x),
      String(options.y),
      BUTTONS[options.direction],
      String(options.steps),
      String(pace.glideMs),
      String(pace.settleMs),
      shot,
    ],
    // The helper turns the wheel once per step, 50 ms apart.
    extraMs: (pace) => pace.glideMs + options.steps * 50 + pace.settleMs,
  });
  const progress = yield* Progress;
  yield* progress.done(
    `scrolled ${options.direction} ${options.steps} at ${options.x},${options.y}`,
  );
}, Effect.scoped);
