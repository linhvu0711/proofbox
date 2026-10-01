import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Duration, Effect, Schedule } from "effect";
import { ProviderError } from "../errors.ts";
import { ownStart, stillRuns } from "./paths.ts";

// A held start lock, inside this file only: it tells the retry to try
// again.
class StartLockHeldError extends Data.TaggedError("StartLockHeldError") {}

interface Owner {
  readonly pid: number;
  readonly token: string;
  readonly started: string;
}

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

// The owner of the lock at `dir`, or undefined when no lock is there.
const readOwner = async (dir: string): Promise<Owner | undefined> => {
  try {
    const text = await readFile(join(dir, "owner"), "utf8");
    const [pid = "", token = "", started = ""] = text.split("\n");
    return { pid: Number(pid), token, started };
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
};

// Build the lock whole in a temp dir, then rename it into place. A rename
// onto a lock that is there fails, so a lock never shows without its
// owner.
const take = async (dir: string, token: string, started: string) => {
  const temp = `${dir}.${token}.tmp`;
  try {
    await mkdir(temp);
    await writeFile(
      join(temp, "owner"),
      `${process.pid}\n${token}\n${started}\n`,
    );
    await rename(temp, dir);
    return true;
  } catch (cause) {
    if (hasCode(cause, "ENOTEMPTY") || hasCode(cause, "EEXIST")) {
      return false;
    }
    throw cause;
  } finally {
    await removeDir(temp);
  }
};

// Move a stale lock aside, and delete it only when it is the lock that
// was judged stale. A lock another Keeper took in the meantime goes back.
const takeOver = async (dir: string, stale: Owner, token: string) => {
  const aside = `${dir}.${token}.stale`;
  try {
    await rename(dir, aside);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return;
    }
    throw cause;
  }
  if ((await readOwner(aside))?.token === stale.token) {
    await removeDir(aside);
    return;
  }
  await rename(aside, dir).catch(() => removeDir(aside));
};

// One try at the lock: take it, or take over one whose owner is gone,
// which is a Keeper killed mid-start. A process id that some other process
// reuses does not pass for the owner.
const tryTake = Effect.fn("startLock.tryTake")(function* (
  dir: string,
  token: string,
  started: string,
  failed: (cause: unknown) => ProviderError,
) {
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => failed(cause) });
  if (yield* attempt(() => take(dir, token, started))) {
    return true;
  }
  const owner = yield* attempt(() => readOwner(dir));
  if (owner === undefined) {
    return yield* attempt(() => take(dir, token, started));
  }
  const live =
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    (yield* stillRuns(owner.pid, owner.started));
  if (live) {
    return false;
  }
  yield* attempt(() => takeOver(dir, owner, token));
  return yield* attempt(() => take(dir, token, started));
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
  const failed = (cause: unknown) =>
    new ProviderError({
      provider,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
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
      Effect.promise(async () => {
        if ((await readOwner(dir).catch(() => undefined))?.token === token) {
          await removeDir(dir).catch(() => {});
        }
      }),
  );
});
