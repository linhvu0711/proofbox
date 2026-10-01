import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Duration, Effect, Schedule } from "effect";
import { ProviderError } from "../errors.ts";

// A start holds its lock for a few ms. A lock this old was left by a
// Keeper whose pid now names some other process.
const STALE_AFTER_MS = 30_000;

// A held start lock, inside this file only: it tells the retry to try
// again.
class StartLockHeldError extends Data.TaggedError("StartLockHeldError") {}

interface Owner {
  readonly pid: number;
  readonly token: string;
  readonly at: number;
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
    const [text, info] = await Promise.all([
      readFile(join(dir, "owner"), "utf8"),
      stat(dir),
    ]);
    const [pid = "", token = ""] = text.trim().split(" ");
    return { pid: Number(pid), token, at: info.mtimeMs };
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
};

// A lock is stale when its owner is gone: the Keeper was killed mid-start.
const isStale = (owner: Owner) => {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return true;
  }
  if (Date.now() - owner.at > STALE_AFTER_MS) {
    return true;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (cause) {
    return hasCode(cause, "ESRCH");
  }
};

// Build the lock whole in a temp dir, then rename it into place. A rename
// onto a lock that is there fails, so a lock never shows without its
// owner.
const take = async (dir: string, token: string) => {
  const temp = `${dir}.${token}.tmp`;
  try {
    await mkdir(temp);
    await writeFile(join(temp, "owner"), `${process.pid} ${token}\n`);
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

// One try at the lock: take it, or take over a stale one.
const tryTake = async (dir: string, token: string) => {
  if (await take(dir, token)) {
    return true;
  }
  const owner = await readOwner(dir);
  if (owner === undefined) {
    return take(dir, token);
  }
  if (isStale(owner)) {
    await takeOver(dir, owner, token);
    return take(dir, token);
  }
  return false;
};

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
  const acquire = Effect.tryPromise({
    try: () => tryTake(dir, token),
    catch: (cause) => failed(cause),
  }).pipe(
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
