import { Effect } from "effect";
import { runPixel, writeOut } from "../pixel.ts";

export const takeScreenshot = (rawId: string, out: string) =>
  Effect.gen(function* () {
    const bytes = yield* runPixel(rawId, ["screenshot"]);
    yield* writeOut(out, bytes);
  }).pipe(Effect.scoped);
