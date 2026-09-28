import { Effect } from "effect";
import {
  BadMarkError,
  NoRecordingError,
  ProviderError,
} from "../errors.ts";
import { runHelper } from "../helper.ts";
import { RECORD_HELPER } from "./record.ts";

export const setMark = (options: { readonly id: string; readonly label: string }) =>
  Effect.gen(function* () {
    if (
      options.label.length < 1 ||
      options.label.length > 60 ||
      options.label.includes("\n") ||
      options.label.includes("\r")
    ) {
      return yield* new BadMarkError({ label: options.label });
    }
    const marked = yield* runHelper(
      options.id,
      RECORD_HELPER,
      ["mark", options.label],
      { outcome: "no Step mark was set" },
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
  }).pipe(Effect.scoped);
