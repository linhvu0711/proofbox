import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { BadLoginsFileError } from "../errors.ts";

export const SavedLogin = Schema.Struct({
  way: Schema.Literal("token"),
  token: Schema.Redacted(Schema.String),
  account: Schema.String,
  expiresAt: Schema.Date,
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

// Write a temp file and rename it over logins.json, so a crash never
// leaves half a file; the dir and file stay readable by the owner only.
export const saveLogins = (logins: LoginsFile) =>
  Effect.gen(function* () {
    const path = yield* loginsPath;
    const dir = dirname(path);
    const temp = `${path}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // mkdir's mode only applies to a new dir, so chmod always.
        await chmod(dir, 0o700);
        await writeFile(
          temp,
          `${JSON.stringify(Schema.encodeSync(LoginsFile)(logins))}\n`,
          { mode: 0o600 },
        );
        await chmod(temp, 0o600);
        await rename(temp, path);
      },
      catch: () =>
        new BadLoginsFileError({ path, reason: "could not be written" }),
    });
  });
