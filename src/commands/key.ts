import { Duration, Effect } from "effect";
import { resolvePace, runPixel } from "../pixel.ts";

export const pressKey = Effect.fn("key.pressKey")(function* (options: {
  readonly id: string;
  readonly keys: string;
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
    ["key", options.keys, String(pace.settleMs), shot],
    {
      screenshot: options.screenshot,
      limit: {
        _tag: "Act",
        name: "key",
        extra: Duration.millis(pace.settleMs),
      },
    },
  );
}, Effect.scoped);
