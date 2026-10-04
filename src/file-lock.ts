import { FileSystem } from "@effect/platform";
import { Data, Duration, Effect, Schedule } from "effect";

// A held lock, inside this file only: it tells the retry to try again.
class LockHeldError extends Data.TaggedError("LockHeldError") {}

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
  ): Effect.Effect<A, E | LockError, R | FileSystem.FileSystem> => {
    const take = Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.makeDirectory(options.dir),
    ).pipe(
      Effect.as(true),
      Effect.catchTag("SystemError", (error) =>
        error.reason === "AlreadyExists"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
      Effect.mapError((error) => options.failed(error)),
      Effect.filterOrFail(
        (held) => held,
        () => new LockHeldError(),
      ),
    );
    return Effect.acquireUseRelease(
      Effect.retry(take, {
        while: (error) => error instanceof LockHeldError,
        schedule: Schedule.spaced(Duration.millis(100)).pipe(
          Schedule.upTo(options.wait),
        ),
      }).pipe(
        Effect.catchIf(
          (error) => error instanceof LockHeldError,
          () => Effect.fail(options.busy()),
        ),
      ),
      () => effect,
      () =>
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(options.dir, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
    );
  };
