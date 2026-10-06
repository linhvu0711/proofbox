import { Effect } from "effect";
import { runPixel, writeOut } from "../pixel.ts";
import { Progress } from "../progress.ts";

export const takeScreenshot = Effect.fn("screenshot.takeScreenshot")(function* (
  rawId: string,
  out: string,
) {
  const bytes = yield* runPixel(rawId, ["screenshot"], {
    limit: { _tag: "Read", name: "screenshot" },
  });
  yield* writeOut(out, bytes);
  const progress = yield* Progress;
  yield* progress.done(`saved ${out}`);
}, Effect.scoped);
