import { Effect } from "effect";
import { runPixel, writeOut } from "../pixel.ts";

export const takeScreenshot = Effect.fn("screenshot.takeScreenshot")(function* (
  rawId: string,
  out: string,
) {
  const bytes = yield* runPixel(rawId, ["screenshot"]);
  yield* writeOut(out, bytes);
}, Effect.scoped);
