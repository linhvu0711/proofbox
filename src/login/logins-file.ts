import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Config, Duration, Effect, Schema } from "effect";
import { BadLoginsFileError, LoginsBusyError } from "../errors.ts";
import { withFileLock } from "../file-lock.ts";

export const SavedLogin = Schema.Struct({
  way: Schema.Literal("token"),
  token: Schema.Redacted(Schema.String),
  account: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Date),
  region: Schema.optional(Schema.String),
});
export type SavedLogin = typeof SavedLogin.Type;

// One slot per Provider, keyed by Provider name.
export const LoginsFile = Schema.Record({
  key: Schema.String,
  value: SavedLogin,
});
export type LoginsFile = typeof LoginsFile.Type;

export const loginsPath = Effect.map(Config.string("HOME"), (home) =>
  join(home, ".config", "proofbox", "logins.json"),
);

// A missing file means no logins; anything unreadable is a bad one.
export const readLogins = Effect.gen(function* () {
  const path = yield* loginsPath;
  const bad = (reason: string) => new BadLoginsFileError({ path, reason });
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(bad("could not be read")),
    ),
  );
  if (text === undefined) {
    return {};
  }
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => bad("not JSON"),
  });
  return yield* Schema.decodeUnknown(LoginsFile)(json).pipe(
    Effect.mapError(() => bad("not a logins file")),
  );
});

// Write a unique temp file and rename it over logins.json, so a crash
// never leaves half a file; the dir and file stay readable by the owner
// only.
const saveLogins = (logins: LoginsFile) =>
  Effect.gen(function* () {
    const path = yield* loginsPath;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await writeFile(
            temp,
            `${JSON.stringify(Schema.encodeSync(LoginsFile)(logins))}\n`,
            { mode: 0o600 },
          );
          await chmod(temp, 0o600);
          await rename(temp, path);
        } catch (cause) {
          await rm(temp, { force: true });
          throw cause;
        }
      },
      catch: () =>
        new BadLoginsFileError({ path, reason: "could not be written" }),
    });
  });

// Each auth command reads, changes one slot, and writes; the lock keeps
// an overlapping command's slot from being dropped by the last write.
// Returns the logins as read under the lock.
export const changeLogins = (change: (logins: LoginsFile) => LoginsFile) =>
  Effect.gen(function* () {
    const path = yield* loginsPath;
    const dir = dirname(path);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // mkdir's mode only applies to a new dir, so chmod always.
        await chmod(dir, 0o700);
      },
      catch: () =>
        new BadLoginsFileError({ path, reason: "could not be written" }),
    });
    const lockDir = join(dir, "logins.lock");
    return yield* withFileLock<LoginsBusyError | BadLoginsFileError>({
      dir: lockDir,
      wait: Duration.seconds(5),
      busy: () => new LoginsBusyError({ lockDir }),
      failed: () =>
        new BadLoginsFileError({ path, reason: "could not be written" }),
    })(
      Effect.gen(function* () {
        const logins = yield* readLogins;
        yield* saveLogins(change(logins));
        return logins;
      }),
    );
  });
