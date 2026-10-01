import { Chunk, Effect, TestClock, TestServices } from "effect";

// Waits, on the real clock, until the TestClock holds a sleep that ends
// within 10 s after each of `ends` (ms since t=0), so a call's own timers
// are set before a test moves the clock. A retry sets its timer at 120 s
// after its start or a little later, as its file reads finish before or
// after the clock stops; the window keeps a Deadline push timer, which
// ends much later, from counting.
export const sleepsNear = (...ends: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const pending = Chunk.toReadonlyArray(yield* TestClock.sleeps());
      if (
        ends.every((end) =>
          pending.some((at) => at >= end && at < end + 10_000),
        )
      ) {
        return;
      }
      yield* TestServices.provideLive(Effect.sleep("10 millis"));
    }
  });
