import { join, resolve } from "node:path";
import { Command, FileSystem } from "@effect/platform";
import { Clock, Config, Effect, Option, Redacted, Stream } from "effect";
import { runKeepingTail } from "./command-tail.ts";
import { harnessEntryFor } from "./commands/harness.ts";
import { withDeadlinePush } from "./deadline.ts";
import {
  NoGithubLoginError,
  NoHarnessLoginError,
  ProviderError,
  platformReason,
  UploadFailedError,
} from "./errors.ts";
import { type GithubRepo, readGithubRepo } from "./github-repo.ts";
import { readGithubLogins } from "./login/github-logins.ts";
import { readHarnessLogins } from "./login/logins-file.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { resolveSandboxId } from "./sandbox-id.ts";

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

const FETCH = `set -eu
IFS= read -r token
url=$1; base=$2; shift 2
if [ ! -d .git ]; then
  entries=$(ls -A)
  git init -q
  {
    if [ -n "$entries" ]; then printf '%s\n' "$entries" | sed 's|^|/|'; fi
    for entry in "$@"; do printf '/%s\n' "$entry"; done
  } >> .git/info/exclude
fi
PROOFBOX_GITHUB_TOKEN=$token GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$PROOFBOX_GITHUB_TOKEN"; }; f' fetch -q "$url" "+refs/heads/$base:refs/remotes/origin/$base"`;

const PLACE = `set -eu
head=$1; branch=$2; base=$3; url=$4; upstream=$5; bundle=$6
if [ "$bundle" = yes ]; then
  dir=$(mktemp -d)
  cat > "$dir/commits.bundle"
  git fetch -q "$dir/commits.bundle" HEAD
  rm -rf "$dir"
fi
if [ -n "$branch" ]; then git checkout -q -f -B "$branch" "$head"; else git checkout -q -f --detach "$head"; fi
git remote add origin "$url" 2>/dev/null || git remote set-url origin "$url"
if [ -n "$branch" ] && [ "$upstream" = yes ]; then git branch -q --set-upstream-to="origin/$base" "$branch"; fi`;

export const cloneWorkFolder = Effect.fn("harnessSandbox.cloneWorkFolder")(
  function* (
    rawId: string,
    folder: string,
    repo: GithubRepo,
    token: Redacted.Redacted<string>,
    ignore: ReadonlyArray<string>,
  ) {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const info = yield* provider.get(id);
    const progress = yield* Progress;
    const fs = yield* FileSystem.FileSystem;
    const github = yield* Config.string("PROOFBOX_GITHUB_URL").pipe(
      Config.withDefault("https://github.com"),
    );
    const url = `${github}/${repo.owner}/${repo.repo}.git`;
    yield* progress.step(
      `cloning ${repo.owner}/${repo.repo}`,
      withDeadlinePush(
        provider,
        id,
        info,
      )(
        Effect.gen(function* () {
          const fetched = yield* runKeepingTail(
            rawId,
            ["sh", "-c", FETCH, "sh", url, repo.base, ...ignore],
            Stream.make(new TextEncoder().encode(`${Redacted.value(token)}\n`)),
          );
          if (fetched.code !== 0)
            return yield* new UploadFailedError({
              id: rawId,
              command: "git",
              code: fetched.code,
            });
          let bundle: Uint8Array | undefined;
          if (repo.baseCommit !== repo.head) {
            const dir = yield* fs.makeTempDirectoryScoped();
            const path = join(dir, "commits.bundle");
            const code = yield* Command.exitCode(
              Command.make(
                "git",
                "bundle",
                "create",
                path,
                `${repo.baseCommit}..HEAD`,
              ).pipe(Command.workingDirectory(resolve(folder))),
            ).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderError({
                    provider: "local",
                    reason: platformReason(error),
                  }),
              ),
            );
            if (code !== 0)
              return yield* new UploadFailedError({
                id: rawId,
                command: "git",
                code,
              });
            bundle = yield* fs
              .readFile(path)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderError({
                      provider: "local",
                      reason: platformReason(error),
                    }),
                ),
              );
          }
          const placed = yield* runKeepingTail(
            rawId,
            [
              "sh",
              "-c",
              PLACE,
              "sh",
              repo.head,
              Option.getOrElse(repo.branch, () => ""),
              repo.base,
              url,
              repo.upstream ? "yes" : "no",
              bundle === undefined ? "no" : "yes",
            ],
            bundle === undefined ? undefined : Stream.make(bundle),
          );
          if (placed.code !== 0)
            return yield* new UploadFailedError({
              id: rawId,
              command: "git",
              code: placed.code,
            });
        }),
      ),
    );
  },
);
