import { Clock, Duration, Effect, Exit, Option, Ref, Schedule } from "effect";
import { CliOutput } from "./cli-output.ts";
import { formatElapsed } from "./format-time.ts";
import { Style } from "./style.ts";

export class Progress extends Effect.Service<Progress>()("proofbox/Progress", {
  dependencies: [Style.Default],
  effect: Effect.gen(function* () {
    const output = yield* CliOutput;
    const style = yield* Style;
    const running = yield* Ref.make<
      Option.Option<{ readonly label: string; readonly started: number }>
    >(Option.none());
    const writes = yield* Effect.makeSemaphore(1);
    const clear = "\r\u001b[2K";
    const line = (step: { readonly label: string; readonly started: number }) =>
      Effect.gen(function* () {
        const ms = (yield* Clock.currentTimeMillis) - step.started;
        const time = formatElapsed(Duration.millis(ms));
        const frame = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(ms / 80) % 10] ?? "⠋";
        const columns = yield* style.columns;
        const label = style.cut(step.label, columns - 1 - 4 - time.length);
        return `${style.paint("spin", frame)} ${label}  ${style.paint("dim", time)}`;
      });
    const draw = writes.withPermits(1)(
      Effect.gen(function* () {
        const step = yield* Ref.get(running);
        if (Option.isSome(step))
          yield* output.err(clear + (yield* line(step.value)));
      }),
    );
    const message = (text: string) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const step = yield* Ref.get(running);
          yield* output.err(
            Option.isSome(step)
              ? `${clear}${text}${clear}${yield* line(step.value)}`
              : text,
          );
        }),
      );
    const step = Effect.fn("Progress.step")(function* <A, E, R>(
      label: string,
      effect: Effect.Effect<A, E, R>,
    ) {
      const started = yield* Clock.currentTimeMillis;
      if (style.live) {
        yield* Ref.set(running, Option.some({ label, started }));
        yield* draw;
      }
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
        Effect.raceFirst(
          style.live
            ? Effect.sleep("80 millis").pipe(
                Effect.zipRight(
                  draw.pipe(
                    Effect.repeat(Schedule.spaced("80 millis")),
                    Effect.forever,
                  ),
                ),
              )
            : heartbeat,
        ),
        Effect.onExit((exit) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              if (style.live) yield* Ref.set(running, Option.none());
              if (Exit.isInterrupted(exit)) {
                if (style.live) yield* output.err(clear);
                return;
              }
              if (!style.look) return;
              const elapsed = Duration.millis(
                (yield* Clock.currentTimeMillis) - started,
              );
              const completed = Exit.isSuccess(exit)
                ? `${style.mark("ok")} ${label}  ${style.paint("dim", formatElapsed(elapsed))}\n`
                : `${style.mark("bad")} ${label}\n`;
              yield* output.err((style.live ? clear : "") + completed);
            }),
          ),
        ),
      );
    });
    // A warning: something went wrong, and the command goes on without it.
    const warn = Effect.fn("Progress.warn")((text: string) =>
      message(
        style.look ? `${style.mark("warn")} ${text}\n` : `proofbox: ${text}\n`,
      ),
    );
    const note = Effect.fn("Progress.note")((text: string) =>
      message(
        style.look
          ? `${style.paint("dim", `  ${text}`)}\n`
          : `proofbox: ${text}\n`,
      ),
    );
    // Done: a command that has nothing else to say worked. Only a person
    // reads it, so it shows only with the look.
    const done = Effect.fn("Progress.done")((text: string) =>
      style.look ? message(`${style.mark("ok")} ${text}\n`) : Effect.void,
    );
    // A hint: the next command to run. Only a person reads it, so it shows
    // only with the look.
    const hint = Effect.fn("Progress.hint")((text: string) =>
      style.look
        ? message(`${style.paint("dim", `  ${text}`)}\n`)
        : Effect.void,
    );
    return { step, warn, note, done, hint };
  }),
}) {}
