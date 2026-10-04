import { Effect, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  InvalidGithubOwnerError,
  NotFineGrainedTokenError,
} from "../errors.ts";
import { saveGithubLogin } from "../login/github-logins.ts";
import { readStdin } from "../login/stdin.ts";

export const loginToGithub = Effect.fn("github.loginToGithub")(function* (
  owner: string,
) {
  owner = owner.toLowerCase();
  if (
    owner.match(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/)?.[0] !== owner
  ) {
    return yield* new InvalidGithubOwnerError({ owner });
  }
  const token = (yield* readStdin()).trim();
  if (token === "" || !token.startsWith("github_pat_")) {
    return yield* new NotFineGrainedTokenError({ owner });
  }
  const before = yield* saveGithubLogin(owner, Redacted.make(token));
  const previous = before[owner];
  const replaced =
    previous === undefined
      ? ""
      : ` (replaced token …${Redacted.value(previous.token).slice(-4)})`;
  const output = yield* CliOutput;
  yield* output.err(`Saved the GitHub login for ${owner}${replaced}.\n`);
  yield* output.err(
    "Protect main, or your default branch, with a ruleset that needs a review: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository\n",
  );
});
