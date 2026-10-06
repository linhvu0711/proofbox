import { Duration, Effect } from "effect";
import { BadMarkError, NoRecordingError, ProviderError } from "../errors.ts";
import { runHelper } from "../helper.ts";
import { Progress } from "../progress.ts";
import { RECORD_HELPER } from "./record.ts";

// The most characters a mark keeps; a longer label is cut to this many.
const MARK_MAX = 60;

// Characters are code points. The cut never splits an emoji: one that would
// cross the limit, such as a thumbs-up with a skin tone, is left out whole.
const cutLabel = (label: string): string => {
  if (Array.from(label).length <= MARK_MAX) return label;
  let kept = "";
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(label)) {
    count += Array.from(segment).length;
    if (count > MARK_MAX) break;
    kept += segment;
  }
  return kept;
};

export const setMark = Effect.fn("mark.setMark")(function* (options: {
  readonly id: string;
  readonly label: string;
  readonly wait: boolean;
}) {
  if (
    options.label.length < 1 ||
    options.label.includes("\n") ||
    options.label.includes("\r")
  ) {
    return yield* new BadMarkError({ label: options.label });
  }
  const label = cutLabel(options.label);
  const marked = yield* runHelper(
    options.id,
    RECORD_HELPER,
    options.wait ? ["wait", JSON.stringify(label)] : ["mark", label],
    {
      outcome: options.wait ? "no Wait mark was set" : "no Step mark was set",
      limit: { _tag: "Act", name: "mark", extra: Duration.zero },
    },
  );
  if (marked.code === 5) {
    return yield* new NoRecordingError({ id: options.id });
  }
  if (marked.code !== 0) {
    return yield* new ProviderError({
      provider: marked.provider,
      reason: `Recording helper failed: ${marked.stderr}`,
    });
  }
  const progress = yield* Progress;
  if (label !== options.label) {
    yield* progress.warn(
      `${options.wait ? "Wait" : "Step"} mark cut to ${MARK_MAX} characters: "${label}"`,
    );
  }
  yield* progress.done(
    options.wait ? `Wait mark "${label}"` : `Step mark "${label}"`,
  );
}, Effect.scoped);
