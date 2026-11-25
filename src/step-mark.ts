import { Effect } from "effect";
import { BadMarkError } from "./errors.ts";
import { Progress } from "./progress.ts";

// The most characters a mark keeps; a longer label is cut to this many.
export const MARK_MAX = 60;

// Characters are code points. The cut never splits an emoji: one that would
// cross the limit, such as a thumbs-up with a skin tone, is left out whole.
// A first character that is itself over the limit, such as a letter with
// many accents, is cut by code point, so the mark is never empty.
const cutLabel = (label: string): string => {
  const points = Array.from(label);
  if (points.length <= MARK_MAX) return label;
  let kept = "";
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(label)) {
    count += Array.from(segment).length;
    if (count > MARK_MAX) break;
    kept += segment;
  }
  return kept === "" ? points.slice(0, MARK_MAX).join("") : kept;
};

export const checkMarkLabel = Effect.fn("stepMark.checkMarkLabel")(function* (
  label: string,
) {
  if (label.length < 1 || label.includes("\n") || label.includes("\r")) {
    return yield* new BadMarkError({ label });
  }
  return cutLabel(label);
});

export const reportMark = Effect.fn("stepMark.reportMark")(function* (options: {
  readonly label: string;
  readonly given: string;
  readonly wait: boolean;
}) {
  const progress = yield* Progress;
  if (options.label !== options.given) {
    yield* progress.warn(
      `${options.wait ? "Wait" : "Step"} mark cut to ${MARK_MAX} characters: "${options.label}"`,
    );
  }
  yield* progress.done(
    options.wait
      ? `Wait mark "${options.label}"`
      : `Step mark "${options.label}"`,
  );
});
