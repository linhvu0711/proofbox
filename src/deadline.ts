import { Clock, Duration, Effect, Schedule } from "effect";
import {
  type BadLoginsFileError,
  BadSpanError,
  type LoginExpiredError,
  type NotLoggedInError,
  type ProviderError,
  type ProviderUnavailableError,
  type SandboxGoneError,
} from "./errors.ts";
import type { Os, Provider, SandboxInfo } from "./provider.ts";

export const idleDefault = (os: Os): Duration.Duration =>
  os === "macos" ? Duration.minutes(5) : Duration.minutes(15);

export const MAX_LIFE_DEFAULT = Duration.hours(3);

export interface SpanSpec {
  readonly units: ReadonlyArray<"ms" | "s" | "m" | "h">;
  readonly zero: boolean;
  readonly example: string;
}

export const IDLE_SPAN: SpanSpec = {
  units: ["s", "m", "h"],
  zero: false,
  example: "15m",
};

export const PACE_SPAN: SpanSpec = {
  units: ["ms", "s"],
  zero: true,
  example: "400ms",
};

const spanPattern = (spec: SpanSpec): RegExp => {
  // Longest unit first so "ms" wins over "s".
  const units = [...spec.units].sort((a, b) => b.length - a.length).join("|");
  const number = spec.zero ? "0|[1-9][0-9]*" : "[1-9][0-9]*";
  return new RegExp(`^(${number})(${units})$`);
};

export const parseSpan = (
  flag: string,
  value: string,
  spec: SpanSpec = IDLE_SPAN,
): Effect.Effect<Duration.Duration, BadSpanError> => {
  const match = spanPattern(spec).exec(value);
  if (match === null) {
    return Effect.fail(
      new BadSpanError({
        flag,
        value,
        units: spec.units,
        example: spec.example,
      }),
    );
  }
  const count = Number(match[1]);
  const unit =
    match[2] === "ms"
      ? 1
      : match[2] === "s"
        ? 1_000
        : match[2] === "m"
          ? 60_000
          : 3_600_000;
  const millis = count * unit;
  if (
    !Number.isFinite(millis) ||
    Number.isNaN(new Date(Date.now() + millis).getTime())
  ) {
    return Effect.fail(
      new BadSpanError({
        flag,
        value,
        units: spec.units,
        example: spec.example,
      }),
    );
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

// One push of the Sandbox Deadline: idle from `now`, capped at max life.
export const deadlinePush = (
  provider: Provider,
  name: string,
  info: SandboxInfo,
): Effect.Effect<
  void,
  | BadLoginsFileError
  | LoginExpiredError
  | NotLoggedInError
  | SandboxGoneError
  | ProviderError
  | ProviderUnavailableError
> =>
  Effect.flatMap(Clock.currentTimeMillis, (millis) =>
    provider.extend(
      name,
      nextDeadline({
        now: new Date(millis),
        idle: Duration.seconds(info.idleSeconds),
        maxLifeAt: info.maxLifeAt,
      }),
    ),
  );

export const withDeadlinePush =
  (provider: Provider, name: string, info: SandboxInfo) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    | BadLoginsFileError
    | E
    | LoginExpiredError
    | NotLoggedInError
    | ProviderError
    | ProviderUnavailableError
    | SandboxGoneError,
    R
  > =>
    Effect.gen(function* () {
      const idle = Duration.seconds(info.idleSeconds);
      const push = deadlinePush(provider, name, info);
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
