import { it } from "@effect/vitest";
import { Chunk, Effect, Ref } from "effect";
import { describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { encodeUnderLimit } from "../src/proof/size-limit.ts";

describe("Size limit", () => {
  it.effect("an over-limit video is built again at lower quality", () =>
    Effect.gen(function* () {
      // Given
      const sizes = [12_400_000, 9_100_000];
      const crfs: number[] = [];
      const encode = (crf: number) => {
        crfs.push(crf);
        return Effect.succeed(sizes[crfs.length - 1] ?? 0);
      };
      // When
      const bytes = yield* encodeUnderLimit(encode, {
        limit: 10_000_000,
        raw: "/run/proofbox/recordings/1/raw.mkv",
      });
      const output = yield* CliOutput;
      const err = Chunk.toReadonlyArray(
        yield* Ref.get(output.captured.err),
      ).join("");
      // Then
      expect(bytes).toBe(9_100_000);
      expect(crfs).toEqual([23, 28]);
      expect(err).toBe(
        "proofbox: Proof video is 12.4 MB, over the 10.0 MB Size limit; trying lower quality\n",
      );
    }).pipe(Effect.provide(CliOutput.Test)),
  );

  it.effect("a video still over the limit at the lowest quality is refused", () =>
    Effect.gen(function* () {
      // Given
      const sizes = [12_400_000, 11_200_000, 10_600_000];
      const crfs: number[] = [];
      const encode = (crf: number) => {
        crfs.push(crf);
        return Effect.succeed(sizes[crfs.length - 1] ?? 0);
      };
      // When
      const error = yield* encodeUnderLimit(encode, {
        limit: 10_000_000,
        raw: "/run/proofbox/recordings/1/raw.mkv",
      }).pipe(Effect.flip);
      // Then
      expect(error._tag).toBe("ProofTooBigError");
      expect(error.message).toBe(
        "Proof video is 10.6 MB at the lowest quality, over the 10.0 MB Size limit, so nothing was downloaded. The raw Recording stays at /run/proofbox/recordings/1/raw.mkv; record a shorter walk, or raise --max-size.",
      );
    }).pipe(Effect.provide(CliOutput.Test)),
  );
});
