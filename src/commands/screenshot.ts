import { Effect } from "effect";
import { runPixel, writeOut } from "../pixel.ts";

export const takeScreenshot = Effect.fn("screenshot.takeScreenshot")(function* (
  rawId: string,
  out: string,
) {
  const bytes = yield* runPixel(rawId, ["screenshot"], {
    limit: { _tag: "Read", name: "screenshot" },
  });
  yield* writeOut(out, bytes);
}, Effect.scoped);
