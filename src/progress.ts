import { Effect, Ref } from "effect";
import { CliOutput } from "./cli-output.ts";

export class Progress extends Effect.Service<Progress>()("proofbox/Progress", {
  effect: Effect.gen(function* () {
    const output = yield* CliOutput;
    const step = <A, E, R>(
      label: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        yield* output.err(`proofbox: ${label}\n`);
        const seconds = yield* Ref.make(0);
        const heartbeat = Effect.forever(
          Effect.sleep("15 seconds").pipe(
            Effect.zipRight(Ref.updateAndGet(seconds, (n) => n + 15)),
            Effect.flatMap((n) =>
              output.err(`proofbox: still ${label} (${n} s)\n`),
            ),
          ),
        );
        return yield* effect.pipe(Effect.raceFirst(heartbeat));
      });
    // A warning: something went wrong, and the command goes on without it.
    const warn = (text: string) => output.err(`proofbox: ${text}\n`);
    return { step, warn };
  }),
}) {}
