import { Duration, Effect } from "effect";
import { BadMarkError, NoRecordingError, ProviderError } from "../errors.ts";
import { runHelper } from "../helper.ts";
import { Progress } from "../progress.ts";
import { RECORD_HELPER } from "./record.ts";

// The most characters a mark keeps; a longer label is cut to this many.
const MARK_MAX = 60;

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
  // Characters are code points, so the cut never splits an emoji.
  const points = Array.from(options.label);
  const label =
    points.length > MARK_MAX
      ? points.slice(0, MARK_MAX).join("")
      : options.label;
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
