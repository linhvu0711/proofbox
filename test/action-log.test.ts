import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { readActionLog } from "../src/proof/action-log.ts";

describe("Action log", () => {
  const recording = { start: 1000, stop: 1300, duration: 300 };

  it.effect(
    "typing that began before the Recording and ended in it is an action",
    () =>
      Effect.gen(function* () {
        // Given
        const text =
          '{"t":995,"kind":"type","x":0,"y":0}\n{"t":1002,"kind":"typed","x":0,"y":0}\n';
        // When
        const events = yield* readActionLog(text, recording);
        // Then
        expect(events).toEqual({
          marks: [],
          clicks: [],
          waits: [],
          actions: [],
          spans: [[0, 2]],
          acted: true,
        });
      }),
  );

  it.effect(
    "a type line from before the Recording with no typed line is no action",
    () =>
      Effect.gen(function* () {
        // Given: the case above with its typed line taken out
        const text = '{"t":995,"kind":"type","x":0,"y":0}\n';
        // When
        const events = yield* readActionLog(text, recording);
        // Then
        expect(events.acted).toBe(false);
      }),
  );

  it.effect("Step mark, Wait mark, and screenshot lines are no actions", () =>
    Effect.gen(function* () {
      // Given
      const text =
        '{"t":1004,"kind":"mark","x":0,"y":0,"step":1}\n' +
        '{"t":1005,"kind":"wait","x":0,"y":0,"reason":"waiting for the scheduler"}\n' +
        '{"t":1006,"kind":"screenshot","x":0,"y":0}\n';
      // When
      const events = yield* readActionLog(text, recording);
      // Then
      expect(events).toEqual({
        marks: [4],
        clicks: [],
        waits: [{ t: 5, reason: "waiting for the scheduler" }],
        actions: [],
        spans: [],
        acted: false,
      });
    }),
  );
});
