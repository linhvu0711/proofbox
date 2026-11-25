import { Duration, Effect } from "effect";
import { NoRecordingError, ProviderError } from "../errors.ts";
import { runHelper } from "../helper.ts";
import { RECORD_HELPER } from "../pixel.ts";
import { checkMarkLabel, reportMark } from "../step-mark.ts";

export const setMark = Effect.fn("mark.setMark")(function* (options: {
  readonly id: string;
  readonly label: string;
  readonly wait: boolean;
}) {
  const label = yield* checkMarkLabel(options.label);
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
  yield* reportMark({ label, given: options.label, wait: options.wait });
}, Effect.scoped);
