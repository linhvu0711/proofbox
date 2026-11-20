import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Clock, Data, Duration, Effect, Option, Schedule } from "effect";
import { ownStart, stillRuns } from "./keeper/paths.ts";

// A held lock, inside this file only: it tells the retry to try again.
class LockHeldError extends Data.TaggedError("LockHeldError") {}

interface Owner {
  readonly pid: number;
  readonly token: string;
  readonly started: string;
}

const removeDir = Effect.fn("fileLock.removeDir")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(dir, { recursive: true, force: true });
});

// The owner of the lock at `dir`, or undefined when no owner file is there.
const readOwner = Effect.fn("fileLock.readOwner")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(join(dir, "owner")).pipe(
    Effect.map((text): Owner | undefined => {
      const [pid = "", token = "", started = ""] = text.split("\n");
      return { pid: Number(pid), token, started };
    }),
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
});

// Build the lock whole in a temp dir, then rename it into place, so a lock
// never shows without its owner. A rename onto an empty dir replaces it, so
// a lock dir with no owner, from an older proofbox, is checked for just
// before the rename.
const take = Effect.fn("fileLock.take")(function* (
  dir: string,
  token: string,
  started: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${dir}.${token}.tmp`;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(temp);
    yield* fs.writeFileString(
      join(temp, "owner"),
      `${process.pid}\n${token}\n${started}\n`,
    );
    if (yield* fs.exists(dir)) {
      return false;
    }
    return yield* fs.rename(temp, dir).pipe(
      Effect.as(true),
      // The rename onto a lock that is there fails with EEXIST or
      // ENOTEMPTY, and FileSystem gives ENOTEMPTY the reason "Unknown",
      // so such a failure with a lock found at `dir` is the race this try
      // lost.
      Effect.catchTag("SystemError", (error) =>
        error.reason === "AlreadyExists" || error.reason === "Unknown"
          ? Effect.flatMap(fs.exists(dir), (held) =>
              held ? Effect.succeed(false) : Effect.fail(error),
            )
          : Effect.fail(error),
      ),
    );
  }).pipe(Effect.ensuring(Effect.ignore(removeDir(temp))));
});

// A reclaim guard lives for a few file calls, so one this old was left by
// a taker that was killed while it held the guard.
const STALE_GUARD = Duration.seconds(10);

// Delete a stale lock under a reclaim guard that only one taker can make,
// and only while the lock still names the owner judged gone: a taker that
// read the same dead owner earlier finds the lock replaced and leaves it.
const takeOver = Effect.fn("fileLock.takeOver")(function* (
  dir: string,
  stale: Owner,
) {
  const fs = yield* FileSystem.FileSystem;
  const guard = `${dir}.reclaim`;
  const held = yield* fs.makeDirectory(guard).pipe(
    Effect.as(true),
    Effect.catchTag("SystemError", (error) =>
      error.reason === "AlreadyExists"
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  );
  if (!held) {
    const made = yield* fs.stat(guard).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)),
      Effect.orElseSucceed(() => undefined),
    );
    const now = yield* Clock.currentTimeMillis;
    if (
      made !== undefined &&
      now - made.getTime() > Duration.toMillis(STALE_GUARD)
    ) {
      yield* removeDir(guard);
    }
    return;
  }
  yield* Effect.gen(function* () {
    if ((yield* readOwner(dir))?.token === stale.token) {
      yield* removeDir(dir);
    }
  }).pipe(Effect.ensuring(Effect.ignore(removeDir(guard))));
});

// One try at the lock: take it, or take over one whose owner is gone, as
// a proofbox killed while it held the lock leaves. A process id that some
// other process reuses does not pass for the owner.
const tryTake = Effect.fn("fileLock.tryTake")(function* (
  dir: string,
  token: string,
  started: string,
) {
  if (yield* take(dir, token, started)) {
    return true;
  }
  const owner = yield* readOwner(dir);
  if (owner === undefined) {
    return yield* take(dir, token, started);
  }
  const live =
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    (yield* stillRuns(owner.pid, owner.started));
  if (live) {
    return false;
  }
  yield* takeOver(dir, owner);
  return yield* take(dir, token, started);
});

// The lock names its owner, so the loser retries until `wait` is up, then
// fails with `busy`, while a lock whose owner is gone is taken over at
// once. Release removes the lock only while this call still owns it.
export const withFileLock =
  <LockError>(options: {
    readonly dir: string;
    readonly wait: Duration.DurationInput;
    readonly busy: () => LockError;
    readonly failed: (cause: PlatformError) => LockError;
  }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | LockError,
    R | FileSystem.FileSystem | CommandExecutor.CommandExecutor
  > =>
    // A token per run: one built effect can run twice at once.
    Effect.suspend(() => {
      const token = randomBytes(8).toString("hex");
      const acquire = Effect.flatMap(ownStart, (started) =>
        tryTake(options.dir, token, started),
      ).pipe(
        Effect.mapError((error) => options.failed(error)),
        Effect.filterOrFail(
          (held) => held,
          () => new LockHeldError(),
        ),
        Effect.retry({
          while: (error) => error instanceof LockHeldError,
          schedule: Schedule.spaced(Duration.millis(100)).pipe(
            Schedule.upTo(options.wait),
          ),
        }),
        Effect.catchIf(
          (error): error is LockHeldError => error instanceof LockHeldError,
          () => Effect.fail(options.busy()),
        ),
      );
      return Effect.acquireUseRelease(
        acquire,
        () => effect,
        () =>
          readOwner(options.dir).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((owner) =>
              owner?.token === token ? removeDir(options.dir) : Effect.void,
            ),
            Effect.ignore,
          ),
      );
    });
