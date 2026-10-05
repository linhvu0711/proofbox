import { Clock, Duration, Effect, Exit, Ref } from "effect";
import { CliOutput } from "./cli-output.ts";
import { formatElapsed } from "./format-time.ts";
import { Style } from "./style.ts";

export class Progress extends Effect.Service<Progress>()("proofbox/Progress", {
  dependencies: [Style.Default],
  effect: Effect.gen(function* () {
    const output = yield* CliOutput;
    const style = yield* Style;
    const step = Effect.fn("Progress.step")(function* <A, E, R>(
      label: string,
      effect: Effect.Effect<A, E, R>,
    ) {
      const started = yield* Clock.currentTimeMillis;
      if (!style.look) yield* output.err(`proofbox: ${label}\n`);
      const seconds = yield* Ref.make(0);
      const heartbeat = Effect.forever(
        Effect.sleep("15 seconds").pipe(
          Effect.zipRight(Ref.updateAndGet(seconds, (n) => n + 15)),
          Effect.flatMap((n) =>
            output.err(
              style.look
                ? `${style.paint("dim", `  still ${label} (${n} s)`)}\n`
                : `proofbox: still ${label} (${n} s)\n`,
            ),
          ),
        ),
      );
      return yield* effect.pipe(
        Effect.raceFirst(heartbeat),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (!style.look || Exit.isInterrupted(exit)) return;
            const elapsed = Duration.millis(
              (yield* Clock.currentTimeMillis) - started,
            );
            yield* output.err(
              Exit.isSuccess(exit)
                ? `${style.mark("ok")} ${label}  ${style.paint("dim", formatElapsed(elapsed))}\n`
                : `${style.mark("bad")} ${label}\n`,
            );
          }),
        ),
      );
    });
    // A warning: something went wrong, and the command goes on without it.
    const warn = Effect.fn("Progress.warn")((text: string) =>
      output.err(`proofbox: ${text}\n`),
    );
    return { step, warn };
  }),
}) {}
