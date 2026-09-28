import { Clock, Duration, Effect, Schedule } from "effect";
import {
  BadSpanError,
  type ProviderError,
  type SandboxGoneError,
} from "./errors.ts";
import type { Os, Provider, SandboxInfo } from "./provider.ts";

export const idleDefault = (os: Os): Duration.Duration =>
  os === "macos" ? Duration.minutes(5) : Duration.minutes(15);

export const MAX_LIFE_DEFAULT = Duration.hours(3);

const SPAN_PATTERN = /^([1-9][0-9]*)(s|m|h)$/;

export const parseSpan = (
  flag: string,
  value: string,
): Effect.Effect<Duration.Duration, BadSpanError> => {
  const match = SPAN_PATTERN.exec(value);
  if (match === null) {
    return Effect.fail(new BadSpanError({ flag, value }));
  }
  const count = Number(match[1]);
  const unit = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const millis = count * unit;
  if (
    !Number.isFinite(millis) ||
    Number.isNaN(new Date(Date.now() + millis).getTime())
  ) {
    return Effect.fail(new BadSpanError({ flag, value }));
  }
  return Effect.succeed(Duration.millis(millis));
};

export const nextDeadline = (options: {
  readonly now: Date;
  readonly idle: Duration.Duration;
  readonly maxLifeAt: Date;
}): Date => {
  const pushed = new Date(
    options.now.getTime() + Duration.toMillis(options.idle),
  );
  return pushed < options.maxLifeAt ? pushed : options.maxLifeAt;
};

export const withDeadlinePush =
  (provider: Provider, name: string, info: SandboxInfo) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderError | SandboxGoneError, R> =>
    Effect.gen(function* () {
      const idle = Duration.seconds(info.idleSeconds);
      const push = Effect.flatMap(Clock.currentTimeMillis, (millis) =>
        provider.extend(
          name,
          nextDeadline({
            now: new Date(millis),
            idle,
            maxLifeAt: info.maxLifeAt,
          }),
        ),
      );
      yield* push;
      // The repeated push never completes on its own, so the winner is always
      // the raced effect's value.
      const result = yield* Effect.map(
        effect.pipe(
          Effect.raceFirst(
            Effect.repeat(
              push,
              Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
            ),
          ),
        ),
        (done) => done as A,
      );
      yield* push;
      return result;
    });
