import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { MAX_SIZE_DEFAULT, parseMaxSize } from "../src/upload/max-size.ts";

describe("max-size", () => {
  it.effect("parseMaxSize reads MB and GB", () =>
    Effect.gen(function* () {
      expect(yield* parseMaxSize("800MB")).toBe(800_000_000);
      expect(yield* parseMaxSize("2GB")).toBe(2_000_000_000);
    }),
  );

  it.effect("a bad --max-size is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseMaxSize("1TB"));
      expect(error.message).toBe(
        'Bad --max-size "1TB": use a whole number with MB or GB, for example 800MB',
      );
    }),
  );

  it("the default Work folder limit is 500 MB", () => {
    expect(MAX_SIZE_DEFAULT).toBe(500_000_000);
  });
});
