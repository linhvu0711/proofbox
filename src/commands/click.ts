import { Effect } from "effect";
import { runAction } from "../pixel.ts";
import { Progress } from "../progress.ts";

const BUTTONS = { left: "1", middle: "2", right: "3" } as const;

export const clickAt = Effect.fn("click.clickAt")(function* (options: {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly button: keyof typeof BUTTONS;
  readonly screenshot?: string | undefined;
  readonly pace: "human" | "fast";
  readonly glide?: string | undefined;
  readonly settle?: string | undefined;
  readonly mark?: string | undefined;
}) {
  yield* runAction(options, {
    name: "click",
    points: [[options.x, options.y]],
    args: (pace, shot) => [
      String(options.x),
      String(options.y),
      BUTTONS[options.button],
      String(pace.glideMs),
      String(pace.settleMs),
      shot,
    ],
    extraMs: (pace) => pace.glideMs + pace.settleMs,
  });
  const progress = yield* Progress;
  yield* progress.done(`clicked ${options.x},${options.y}`);
}, Effect.scoped);
