import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { ProofTooBigError } from "../errors.ts";
import { formatMb } from "../upload/max-size.ts";

export const PROOF_SIZE_DEFAULT = 10_000_000;

export const CRF_STEPS = [23, 28, 33] as const;

export const encodeUnderLimit = <E, R>(
  encode: (crf: number) => Effect.Effect<number, E, R>,
  options: { readonly limit: number; readonly raw: string },
) =>
  Effect.gen(function* () {
    const output = yield* CliOutput;
    let last = 0;
    for (const [index, crf] of CRF_STEPS.entries()) {
      const bytes = yield* encode(crf);
      last = bytes;
      if (bytes <= options.limit) {
        return bytes;
      }
      if (index < CRF_STEPS.length - 1) {
        yield* output.err(
          `proofbox: Proof video is ${formatMb(bytes)} MB, over the ${formatMb(options.limit)} MB Size limit; trying lower quality\n`,
        );
      }
    }
    return yield* new ProofTooBigError({
      bytes: last,
      limit: options.limit,
      raw: options.raw,
    });
  });
