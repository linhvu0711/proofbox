import { Effect } from "effect";
import { ProofTooBigError } from "../errors.ts";
import { Progress } from "../progress.ts";
import { formatMb } from "../upload/max-size.ts";

export const PROOF_SIZE_DEFAULT = 10_000_000;

export const CRF_STEPS = [23, 28, 33] as const;

export const encodeUnderLimit = Effect.fn("sizeLimit.encodeUnderLimit")(
  function* <E, R>(
    encode: (crf: number) => Effect.Effect<number, E, R>,
    options: { readonly limit: number; readonly raw: string },
  ) {
    const progress = yield* Progress;
    let last = 0;
    for (const [index, crf] of CRF_STEPS.entries()) {
      const bytes = yield* encode(crf);
      last = bytes;
      if (bytes <= options.limit) {
        return bytes;
      }
      if (index < CRF_STEPS.length - 1) {
        yield* progress.warn(
          `Proof video is ${formatMb(bytes)} MB, over the ${formatMb(options.limit)} MB Size limit; trying lower quality`,
        );
      }
    }
    return yield* new ProofTooBigError({
      bytes: last,
      limit: options.limit,
      raw: options.raw,
    });
  },
);
