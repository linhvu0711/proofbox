import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Duration, Effect, Schedule } from "effect";
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

// Move a stale lock aside, and delete it only when it is the lock that
// was judged stale. A lock another taker took in the meantime goes back.
const takeOver = Effect.fn("fileLock.takeOver")(function* (
  dir: string,
  stale: Owner,
  token: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const aside = `${dir}.${token}.stale`;
  const moved = yield* fs.rename(dir, aside).pipe(
    Effect.as(true),
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
  if (!moved) {
    return;
  }
  if ((yield* readOwner(aside))?.token === stale.token) {
    yield* removeDir(aside);
    return;
  }
  yield* fs.rename(aside, dir).pipe(Effect.catchAll(() => removeDir(aside)));
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
  yield* takeOver(dir, owner, token);
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
