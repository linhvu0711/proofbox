import { join } from "node:path";
import { Config, Effect, type Redacted, Schema } from "effect";
import {
  readOwnerOnlyFile,
  withLoginsLock,
  writeOwnerOnlyFile,
} from "./logins-file.ts";

export const GithubLogin = Schema.Struct({
  token: Schema.Redacted(Schema.String),
});
export type GithubLogin = typeof GithubLogin.Type;

export const GithubLoginsFile = Schema.Record({
  key: Schema.String,
  value: GithubLogin,
});
export type GithubLoginsFile = typeof GithubLoginsFile.Type;

export const githubLoginsPath = Effect.map(Config.string("HOME"), (home) =>
  join(home, ".config", "proofbox", "github-logins.json"),
);

export const readGithubLogins = Effect.flatMap(githubLoginsPath, (path) =>
  readOwnerOnlyFile(path, GithubLoginsFile, {}),
);

export const saveGithubLogin = Effect.fn("githubLogins.saveGithubLogin")(
  (owner: string, token: Redacted.Redacted<string>) =>
    withLoginsLock(
      Effect.gen(function* () {
        const logins = yield* readGithubLogins;
        const path = yield* githubLoginsPath;
        yield* writeOwnerOnlyFile(path, GithubLoginsFile, {
          ...logins,
          [owner]: { token },
        });
        return logins;
      }),
    ),
);
