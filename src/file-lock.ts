import { mkdir, rm } from "node:fs/promises";
import { Duration, Effect, Schedule } from "effect";

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

// mkdir is atomic, so a lock dir serializes overlapping commands: the
// loser retries until `wait` is up, then fails with `busy`. A busy lock
// is never removed by the loser: release runs only after acquire
// succeeded.
export const withFileLock =
  <LockError>(options: {
    readonly dir: string;
    readonly wait: Duration.DurationInput;
    readonly busy: () => LockError;
    readonly failed: (cause: unknown) => LockError;
  }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | LockError, R> => {
    const busy = options.busy();
    const take = Effect.tryPromise({
      try: async () => {
        try {
          await mkdir(options.dir);
          return true;
        } catch (cause) {
          if (hasCode(cause, "EEXIST")) {
            return false;
          }
          throw cause;
        }
      },
      catch: (cause) => options.failed(cause),
    }).pipe(
      Effect.filterOrFail(
        (held) => held,
        () => busy,
      ),
    );
    return Effect.acquireUseRelease(
      Effect.retry(take, {
        while: (error) => error === busy,
        schedule: Schedule.spaced(Duration.millis(100)).pipe(
          Schedule.upTo(options.wait),
        ),
      }),
      () => effect,
      () =>
        Effect.promise(() =>
          rm(options.dir, { recursive: true, force: true }).catch(() => {}),
        ),
    );
  };
