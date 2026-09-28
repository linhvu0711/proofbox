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
  switch (match[2]) {
    case "s":
      return Effect.succeed(Duration.seconds(count));
    case "m":
      return Effect.succeed(Duration.minutes(count));
    default:
      return Effect.succeed(Duration.hours(count));
  }
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
