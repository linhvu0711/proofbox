import { Duration, Effect } from "effect";
import { BadSpanError } from "./errors.ts";
import type { Os } from "./provider.ts";

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
