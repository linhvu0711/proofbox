import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { resolvePace } from "../src/pixel.ts";

describe("Pace", () => {
  it.effect("human pace is the default", () =>
    Effect.gen(function* () {
      // When
      const pace = yield* resolvePace({ pace: "human" });
      // Then
      expect(pace).toEqual({
        glideMs: 400,
        letterMs: 80,
        typeMaxMs: 3000,
        settleMs: 700,
      });
    }),
  );

  it.effect("--pace fast drops the glide and the wait", () =>
    Effect.gen(function* () {
      // When
      const pace = yield* resolvePace({ pace: "fast" });
      // Then
      expect(pace).toEqual({
        glideMs: 0,
        letterMs: 12,
        typeMaxMs: 3000,
        settleMs: 0,
      });
    }),
  );

  it.effect("a pace flag wins over the preset", () =>
    Effect.gen(function* () {
      // When
      const pace = yield* resolvePace({
        pace: "fast",
        settle: "1s",
        glide: "250ms",
      });
      // Then
      expect(pace).toEqual({
        glideMs: 250,
        letterMs: 12,
        typeMaxMs: 3000,
        settleMs: 1000,
      });
    }),
  );

  it.effect("typing is capped at --type-max", () =>
    Effect.gen(function* () {
      // When
      const long = yield* resolvePace({ pace: "human" }, 100);
      const short = yield* resolvePace({ pace: "human" }, 10);
      // Then
      expect(long.letterMs).toBe(30);
      expect(short.letterMs).toBe(80);
    }),
  );

  it.effect("a bad pace flag is refused", () =>
    Effect.gen(function* () {
      // When
      const error = yield* Effect.flip(
        resolvePace({ pace: "human", glide: "0.4s" }),
      );
      // Then
      expect(error.message).toBe(
        'Bad --glide "0.4s": use a whole number with ms or s, for example 400ms',
      );
    }),
  );
});
