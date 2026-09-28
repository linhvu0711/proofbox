import { Effect } from "effect";
import { BadStepsError } from "../errors.ts";
import { resolvePace, runPixel } from "../pixel.ts";

const BUTTONS = { up: "4", down: "5", left: "6", right: "7" } as const;

export const scrollAt = (options: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly direction: keyof typeof BUTTONS;
  readonly steps: number;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly letter?: string | undefined;
  readonly typeMax?: string | undefined;
  readonly settle?: string | undefined;
}) =>
  Effect.gen(function* () {
    if (options.steps < 1) {
      return yield* new BadStepsError({ steps: options.steps });
    }
    const pace = yield* resolvePace(options);
    const shot = options.screenshot === undefined ? "0" : "1";
    yield* runPixel(
      options.id,
      [
        "scroll",
        String(options.x),
        String(options.y),
        BUTTONS[options.direction],
        String(options.steps),
        String(pace.glideMs),
        String(pace.settleMs),
        shot,
      ],
      { screenshot: options.screenshot, points: [[options.x, options.y]] },
    );
  }).pipe(Effect.scoped);
