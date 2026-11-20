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

  it.effect("a type and its typed line make one typing span", () =>
    Effect.gen(function* () {
      // Given
      const text =
        '{"t":1002,"kind":"type","x":0,"y":0}\n{"t":1008,"kind":"typed","x":0,"y":0}\n';
      // When
      const events = yield* readActionLog(text, {
        start: 1000,
        stop: 1010,
        duration: 10,
      });
      // Then
      expect(events.spans).toEqual([[2, 8]]);
    }),
  );

  it.effect(
    "typing still running at record stop runs to the end of the Recording",
    () =>
      Effect.gen(function* () {
        // Given: the case above with its typed line taken out
        const text = '{"t":1002,"kind":"type","x":0,"y":0}\n';
        // When
        const events = yield* readActionLog(text, {
          start: 1000,
          stop: 1010,
          duration: 10,
        });
        // Then
        expect(events.spans).toEqual([[2, 10]]);
      }),
  );

  it.effect(
    "each click, key, scroll, and drag is kept out of the Still parts, like typing",
    () =>
      Effect.gen(function* () {
        // Given
        const text =
          '{"t":1003,"kind":"click","x":720,"y":450}\n' +
          '{"t":1005,"kind":"key","x":0,"y":0}\n' +
          '{"t":1009,"kind":"scroll","x":0,"y":0}\n' +
          '{"t":1014,"kind":"drag","x":0,"y":0,"toX":10,"toY":10}\n' +
          '{"t":1016,"kind":"type","x":0,"y":0}\n' +
          '{"t":1018,"kind":"typed","x":0,"y":0}\n' +
          '{"t":1020,"kind":"mark","x":0,"y":0,"step":1}\n' +
          '{"t":1021,"kind":"wait","x":0,"y":0,"reason":"waiting for the scheduler"}\n' +
          '{"t":1022,"kind":"screenshot","x":0,"y":0}\n';
        // When
        const events = yield* readActionLog(text, {
          start: 1000,
          stop: 1030,
          duration: 30,
        });
        // Then
        expect(events.spans).toEqual([
          [3, 3],
          [5, 5],
          [9, 9],
          [14, 14],
          [16, 18],
        ]);
      }),
  );
});
