import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Config, Duration, Effect, Schema } from "effect";
import { BadLoginsFileError, LoginsBusyError } from "../errors.ts";
import { withFileLock } from "../file-lock.ts";

export const SavedLogin = Schema.Union(
  // The token way: the token itself, saved verbatim.
  Schema.Struct({
    way: Schema.Literal("token"),
    token: Schema.Redacted(Schema.String),
    account: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Date),
    region: Schema.optional(Schema.String),
  }),
  // The browser way: the session the login made and what it was for.
  Schema.Struct({
    way: Schema.Literal("browser"),
    session: Schema.Redacted(Schema.String),
    account: Schema.String,
    expiresAt: Schema.Date,
    region: Schema.optional(Schema.String),
  }),
);
export type SavedLogin = typeof SavedLogin.Type;

// One slot per Provider, keyed by Provider name.
export const LoginsFile = Schema.Record({
  key: Schema.String,
  value: SavedLogin,
});
export type LoginsFile = typeof LoginsFile.Type;

export const SavedHarnessLogin = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  expiresAt: Schema.optional(Schema.Date),
});
export type SavedHarnessLogin = typeof SavedHarnessLogin.Type;

export const HarnessLoginsFile = Schema.Record({
  key: Schema.String,
  value: SavedHarnessLogin,
});
export type HarnessLoginsFile = typeof HarnessLoginsFile.Type;

export const loginsPath = Effect.map(Config.string("HOME"), (home) =>
  join(home, ".config", "proofbox", "logins.json"),
);

export const harnessLoginsPath = Effect.map(Config.string("HOME"), (home) =>
  join(home, ".config", "proofbox", "harness-logins.json"),
);

// A missing file means no logins; anything unreadable is a bad one.
const readFileAt = Effect.fn("loginsFile.readFileAt")(function* <A, I>(
  path: string,
  schema: Schema.Schema<Readonly<Record<string, A>>, I>,
) {
  const fs = yield* FileSystem.FileSystem;
  const bad = (reason: string) => new BadLoginsFileError({ path, reason });
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchAll((error) =>
        error._tag === "SystemError" && error.reason === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(bad("could not be read")),
      ),
    );
  if (text === undefined) {
    return yield* Effect.succeed<Readonly<Record<string, A>>>({});
  }
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => bad("not JSON"),
  });
  return yield* Schema.decodeUnknown(schema)(json).pipe(
    Effect.mapError(() => bad("not a logins file")),
  );
});

export const readLogins = Effect.flatMap(loginsPath, (path) =>
  readFileAt(path, LoginsFile),
);

export const readHarnessLogins = Effect.flatMap(harnessLoginsPath, (path) =>
  readFileAt(path, HarnessLoginsFile),
);

// Write a unique temp file and rename it over the logins file, so a crash
// never leaves half a file; the dir and file stay readable by the owner
// only.
const saveFileAt = Effect.fn("loginsFile.saveFileAt")(function* <A, I>(
  path: string,
  schema: Schema.Schema<A, I>,
  value: A,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(
      temp,
      `${JSON.stringify(Schema.encodeSync(schema)(value))}\n`,
      { mode: 0o600 },
    );
    yield* fs.chmod(temp, 0o600);
    yield* fs.rename(temp, path);
  }).pipe(
    Effect.tapError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    Effect.mapError(
      () => new BadLoginsFileError({ path, reason: "could not be written" }),
    ),
  );
});

const saveLogins = Effect.fn("loginsFile.saveLogins")((logins: LoginsFile) =>
  Effect.flatMap(loginsPath, (path) => saveFileAt(path, LoginsFile, logins)),
);

// The lock every change to logins.json runs under. Create and logout also
// hold it while they check for a login and for a running create, so a
// create either shows up for logout or finds no login (ADR 0016).
export const withLoginsLock = Effect.fn("loginsFile.withLoginsLock")(function* <
  A,
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* loginsPath;
  const dir = dirname(path);
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
    // mkdir's mode only applies to a new dir, so chmod always.
    Effect.zipRight(fs.chmod(dir, 0o700)),
    Effect.mapError(
      () => new BadLoginsFileError({ path, reason: "could not be written" }),
    ),
  );
  const lockDir = join(dir, "logins.lock");
  return yield* withFileLock<LoginsBusyError | BadLoginsFileError>({
    dir: lockDir,
    wait: Duration.seconds(5),
    busy: () => new LoginsBusyError({ lockDir }),
    failed: () =>
      new BadLoginsFileError({ path, reason: "could not be written" }),
  })(effect);
});

// Reads, changes one slot, and writes; only for code that holds the
// logins lock already. Returns the logins as read.
export const rewriteLogins = Effect.fn("loginsFile.rewriteLogins")(function* (
  change: (logins: LoginsFile) => LoginsFile,
) {
  const logins = yield* readLogins;
  yield* saveLogins(change(logins));
  return logins;
});

// Each auth command reads, changes one slot, and writes; the lock keeps
// an overlapping command's slot from being dropped by the last write.
// Returns the logins as read under the lock.
export const changeLogins = Effect.fn("loginsFile.changeLogins")(
  (change: (logins: LoginsFile) => LoginsFile) =>
    withLoginsLock(rewriteLogins(change)),
);

export const changeHarnessLogins = Effect.fn("loginsFile.changeHarnessLogins")(
  (change: (logins: HarnessLoginsFile) => HarnessLoginsFile) =>
    withLoginsLock(
      Effect.gen(function* () {
        const logins = yield* readHarnessLogins;
        const path = yield* harnessLoginsPath;
        yield* saveFileAt(path, HarnessLoginsFile, change(logins));
        return logins;
      }),
    ),
);
