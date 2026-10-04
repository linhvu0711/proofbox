import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Duration, Effect, Schedule } from "effect";
import { ProviderError, platformReason } from "../errors.ts";
import { ownStart, stillRuns } from "./paths.ts";

// A held start lock, inside this file only: it tells the retry to try
// again.
class StartLockHeldError extends Data.TaggedError("StartLockHeldError") {}

interface Owner {
  readonly pid: number;
  readonly token: string;
  readonly started: string;
}

const removeDir = Effect.fn("startLock.removeDir")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(dir, { recursive: true, force: true });
});

// The owner of the lock at `dir`, or undefined when no lock is there.
const readOwner = Effect.fn("startLock.readOwner")(function* (dir: string) {
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

// Build the lock whole in a temp dir, then rename it into place. A rename
// onto a lock that is there fails, so a lock never shows without its
// owner.
const take = Effect.fn("startLock.take")(function* (
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
    yield* fs.rename(temp, dir);
    return true;
  }).pipe(
    // The rename onto a lock that is there fails with EEXIST or
    // ENOTEMPTY, and FileSystem gives ENOTEMPTY the reason "Unknown", so
    // a lock found at `dir` is the race this try lost.
    Effect.catchTag("SystemError", (error) =>
      Effect.flatMap(fs.exists(dir), (held) =>
        held ? Effect.succeed(false) : Effect.fail(error),
      ),
    ),
    Effect.ensuring(Effect.ignore(removeDir(temp))),
  );
});

// Move a stale lock aside, and delete it only when it is the lock that
// was judged stale. A lock another Keeper took in the meantime goes back.
const takeOver = Effect.fn("startLock.takeOver")(function* (
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

// One try at the lock: take it, or take over one whose owner is gone,
// which is a Keeper killed mid-start. A process id that some other process
// reuses does not pass for the owner.
const tryTake = Effect.fn("startLock.tryTake")(function* (
  dir: string,
  token: string,
  started: string,
  failed: (error: PlatformError) => ProviderError,
) {
  const attempt = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
    Effect.mapError(effect, (error) => failed(error));
  if (yield* attempt(take(dir, token, started))) {
    return true;
  }
  const owner = yield* attempt(readOwner(dir));
  if (owner === undefined) {
    return yield* attempt(take(dir, token, started));
  }
  const live =
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    (yield* stillRuns(owner.pid, owner.started));
  if (live) {
    return false;
  }
  yield* attempt(takeOver(dir, owner, token));
  return yield* attempt(take(dir, token, started));
});

// Runs a Keeper's start, from its socket check until it listens, under a
// lock per Sandbox, so a second Keeper started at once waits and then
// finds the first one's socket answers. The lock names its owner, so a
// lock left by a Keeper killed mid-start is taken over at once, and a
// live one never is.
export const withStartLock = Effect.fn("startLock.withStartLock")(function* <
  A,
  E,
  R,
>(dir: string, provider: string, effect: Effect.Effect<A, E, R>) {
  const token = randomBytes(8).toString("hex");
  const failed = (error: PlatformError) =>
    new ProviderError({ provider, reason: platformReason(error) });
  const started = yield* ownStart;
  const acquire = tryTake(dir, token, started, failed).pipe(
    Effect.filterOrFail(
      (held) => held,
      () => new StartLockHeldError(),
    ),
    Effect.retry({
      while: (error) => error instanceof StartLockHeldError,
      schedule: Schedule.spaced(Duration.millis(100)).pipe(
        Schedule.upTo(Duration.seconds(5)),
      ),
    }),
    Effect.catchIf(
      (error): error is StartLockHeldError =>
        error instanceof StartLockHeldError,
      () =>
        Effect.fail(
          new ProviderError({
            provider,
            reason: `another Keeper of this Sandbox is still starting; delete ${dir} if it is stale`,
          }),
        ),
    ),
  );
  return yield* Effect.acquireUseRelease(
    acquire,
    () => effect,
    () =>
      readOwner(dir).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((owner) =>
          owner?.token === token ? removeDir(dir) : Effect.void,
        ),
        Effect.ignore,
      ),
  );
});
