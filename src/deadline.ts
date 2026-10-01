import { Clock, Duration, Effect, Fiber, Schedule, Stream } from "effect";
import {
  type BadLoginsFileError,
  BadSpanError,
  type LoginExpiredError,
  type NotLoggedInError,
  type ProviderError,
  type ProviderLimitError,
  type ProviderUnavailableError,
  type SandboxGoneError,
  type TokenPermissionError,
  type TokenRejectedError,
} from "./errors.ts";
import type {
  Connection,
  Os,
  Provider,
  SandboxCallError,
  SandboxInfo,
  SandboxRef,
} from "./provider.ts";

export const idleDefault = (os: Os): Duration.Duration =>
  os === "macos" ? Duration.minutes(5) : Duration.minutes(15);

export const MAX_LIFE_DEFAULT = Duration.hours(3);

export interface SpanSpec {
  readonly units: ReadonlyArray<"ms" | "s" | "m" | "h" | "d" | "y">;
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

export const TOKEN_SPAN: SpanSpec = {
  units: ["h", "d", "y"],
  zero: false,
  example: "30d",
};

// A `y` is 365 days.
const UNIT_MILLIS: Record<SpanSpec["units"][number], number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  y: 31_536_000_000,
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
  // The match proves match[2] is one of the spec's units.
  const millis = count * UNIT_MILLIS[match[2] as keyof typeof UNIT_MILLIS];
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

// The Deadline one push sets now: idle from now, capped at max life.
export const pushedDeadline = (info: SandboxInfo): Effect.Effect<Date> =>
  Effect.map(Clock.currentTimeMillis, (millis) =>
    nextDeadline({
      now: new Date(millis),
      idle: Duration.seconds(info.idleSeconds),
      maxLifeAt: info.maxLifeAt,
    }),
  );

// One push of the Sandbox Deadline: idle from `now`, capped at max life.
export const deadlinePush = (
  provider: Provider,
  sandbox: SandboxRef,
  info: SandboxInfo,
): Effect.Effect<
  void,
  | BadLoginsFileError
  | LoginExpiredError
  | NotLoggedInError
  | SandboxGoneError
  | ProviderError
  | ProviderLimitError
  | ProviderUnavailableError
  | TokenRejectedError
  | TokenPermissionError
> =>
  Effect.flatMap(pushedDeadline(info), (deadline) =>
    provider.extend(sandbox, deadline),
  );

export const withDeadlinePush =
  (provider: Provider, sandbox: SandboxRef, info: SandboxInfo) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    | BadLoginsFileError
    | E
    | LoginExpiredError
    | NotLoggedInError
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | SandboxGoneError
    | TokenPermissionError
    | TokenRejectedError,
    R
  > =>
    Effect.gen(function* () {
      const idle = Duration.seconds(info.idleSeconds);
      const push = deadlinePush(provider, sandbox, info);
      yield* push;
      // The repeated push never ends (Effect.never after it), so the race
      // gives the raced effect's value.
      const result = yield* effect.pipe(
        Effect.raceFirst(
          Effect.repeat(
            push,
            Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
          ).pipe(Effect.zipRight(Effect.never)),
        ),
      );
      yield* push;
      return result;
    });

// Keeps the Deadline pushed while a command runs, every third of the idle
// time. The command's own call pushes before and after it, so this only
// covers a long run; it stops with the command, never on a timer of its
// own. A failed push ends the run.
export const withRunningPush =
  (connection: Connection) =>
  <A, E, R>(
    events: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | SandboxCallError, R> => {
    const every = Duration.millis(
      Duration.toMillis(Duration.seconds(connection.info.idleSeconds)) / 3,
    );
    const push = Effect.flatMap(
      pushedDeadline(connection.info),
      connection.extend,
    );
    // The command's stream stays on the fiber that reads it: a stdin feed
    // that drains after the command exits depends on that.
    return Stream.unwrapScoped(
      Effect.map(
        Effect.forkScoped(
          Effect.forever(Effect.zipRight(Effect.sleep(every), push)),
        ),
        (pushing) => Stream.interruptWhen(events, Fiber.join(pushing)),
      ),
    );
  };
