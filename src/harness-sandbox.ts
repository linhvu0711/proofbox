import { Clock, Effect } from "effect";
import { harnessEntryFor } from "./commands/harness.ts";
import { NoGithubLoginError, NoHarnessLoginError } from "./errors.ts";
import { readGithubRepo } from "./github-repo.ts";
import { readGithubLogins } from "./login/github-logins.ts";
import { readHarnessLogins } from "./login/logins-file.ts";

export const checkHarnessCreate = Effect.fn(
  "harnessSandbox.checkHarnessCreate",
)(function* (name: string, folder: string) {
  const entry = yield* harnessEntryFor(name);
  const repo = yield* readGithubRepo(folder);
  const harnessLogin = (yield* readHarnessLogins)[name];
  const expired =
    harnessLogin?.expiresAt !== undefined &&
    harnessLogin.expiresAt.getTime() < (yield* Clock.currentTimeMillis);
  if (harnessLogin === undefined || expired) {
    return yield* new NoHarnessLoginError({
      harness: name,
      expired,
      howToMake: entry.login.howToMake,
    });
  }
  const githubLogin = (yield* readGithubLogins)[repo.owner.toLowerCase()];
  if (githubLogin === undefined) {
    return yield* new NoGithubLoginError({
      owner: repo.owner,
      repo: repo.repo,
    });
  }
  return {
    entry,
    repo,
    harnessToken: harnessLogin.token,
    githubToken: githubLogin.token,
  };
});
