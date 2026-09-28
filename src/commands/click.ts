import { Effect } from "effect";
import { PACE_HUMAN, runPixel } from "../pixel.ts";

const BUTTONS = { left: "1", middle: "2", right: "3" } as const;

export const clickAt = (options: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly button: keyof typeof BUTTONS;
  readonly screenshot?: string | undefined;
}) =>
  Effect.gen(function* () {
    const shot = options.screenshot === undefined ? "0" : "1";
    yield* runPixel(
      options.id,
      [
        "click",
        String(options.x),
        String(options.y),
        BUTTONS[options.button],
        String(PACE_HUMAN.glideMs),
        String(PACE_HUMAN.settleMs),
        shot,
      ],
      { screenshot: options.screenshot },
    );
  }).pipe(Effect.scoped);
