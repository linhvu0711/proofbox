import { join, resolve } from "node:path";
import {
  Command,
  FileSystem,
  type Error as PlatformError,
} from "@effect/platform";
import { Clock, Config, Effect, Option, Redacted, Stream } from "effect";
import { CliOutput } from "./cli-output.ts";
import { runKeepingTail } from "./command-tail.ts";
import { harnessEntryFor } from "./commands/harness.ts";
import { runInSandbox } from "./commands/upload.ts";
import { withDeadlinePush } from "./deadline.ts";
import {
  CloneRefusedError,
  HarnessInstallFailedError,
  NoGithubLoginError,
  NoHarnessLoginError,
  ProviderError,
  platformReason,
  UploadFailedError,
} from "./errors.ts";
import { type GithubRepo, readGithubRepo } from "./github-repo.ts";
import type { Harness } from "./harness.ts";
import { harnessProfilePath } from "./harness-profile.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { readGithubLogins } from "./login/github-logins.ts";
import {
  readHarnessLoginFile,
  readHarnessLogins,
} from "./login/logins-file.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { resolveSandboxId } from "./sandbox-id.ts";
import { MAX_SIZE_DEFAULT } from "./upload/max-size.ts";
import { packFiles } from "./upload/pack.ts";

export const copyHarnessProfile = Effect.fn(
  "harnessSandbox.copyHarnessProfile",
)(function* (rawId: string, harness: Harness) {
  const dir = yield* harnessProfilePath(harness.name);
  const fs = yield* FileSystem.FileSystem;
  const local = (error: PlatformError.PlatformError) =>
    new ProviderError({ provider: "local", reason: platformReason(error) });
  if (!(yield* fs.exists(dir).pipe(Effect.mapError(local)))) return;
  const paths = (yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.mapError(local))).sort();
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const info = yield* id.provider.get(id);
  const progress = yield* Progress;
  const keeper = yield* KeeperClient;
  yield* progress.step(
    "copying the Harness profile",
    withDeadlinePush(
      id.provider,
      id,
      info,
    )(
      runInSandbox(
        keeper,
        rawId,
        [
          "sh",
          "-c",
          'umask 077; mkdir -p "$HOME/$1" && tar -x -f - -C "$HOME/$1"',
          "sh",
          harness.home,
        ],
        packFiles(dir, rawId, paths, MAX_SIZE_DEFAULT),
      ),
    ),
  );
});

export const checkHarnessCreate = Effect.fn(
  "harnessSandbox.checkHarnessCreate",
)(function* (name: string, folder: string) {
  const entry = yield* harnessEntryFor(name);
  const repo = yield* readGithubRepo(folder);
  let harnessLogin:
    | { readonly _tag: "Env"; readonly token: Redacted.Redacted<string> }
    | { readonly _tag: "File"; readonly text: string };
  if (entry.login._tag === "File") {
    const text = yield* readHarnessLoginFile(name, entry.login.file);
    if (Option.isNone(text)) {
      return yield* new NoHarnessLoginError({
        harness: name,
        expired: false,
        howToMake: entry.login.howToMake,
      });
    }
    harnessLogin = { _tag: "File", text: text.value };
  } else {
    const saved = (yield* readHarnessLogins)[name];
    const expired =
      saved?.expiresAt !== undefined &&
      saved.expiresAt.getTime() < (yield* Clock.currentTimeMillis);
    if (saved === undefined || expired) {
      return yield* new NoHarnessLoginError({
        harness: name,
        expired,
        howToMake: entry.login.howToMake,
      });
    }
    harnessLogin = { _tag: "Env", token: saved.token };
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
    harnessLogin,
    githubToken: githubLogin.token,
  };
});

export const sendHarnessLoginFile = Effect.fn(
  "harnessSandbox.sendHarnessLoginFile",
)(function* (rawId: string, harness: Harness, file: string, text: string) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const info = yield* id.provider.get(id);
  const progress = yield* Progress;
  const keeper = yield* KeeperClient;
  yield* progress.step(
    "sending the Harness login",
    withDeadlinePush(
      id.provider,
      id,
      info,
    )(
      runInSandbox(
        keeper,
        rawId,
        [
          "sh",
          "-c",
          'umask 077; mkdir -p "$HOME/$1" && cat > "$HOME/$1/$2" && chmod 600 "$HOME/$1/$2"',
          "sh",
          harness.home,
          file,
        ],
        Stream.make(new TextEncoder().encode(text)),
      ),
    ),
  );
});

const FETCH = `set -eu
IFS= read -r token
url=$1; base=$2; keep=$3; shift 3
if [ ! -d .git ]; then
  entries=$(ls -A)
  git init -q
  {
    if [ -n "$entries" ]; then
      printf '%s\n' "$entries" | while IFS= read -r entry; do
        kept=no; left=$keep
        for name in "$@"; do
          if [ "$left" -eq 0 ]; then break; fi
          if [ "$entry" = "$name" ]; then kept=yes; break; fi
          left=$((left - 1))
        done
        if [ "$kept" = no ]; then printf '/%s\n' "$entry"; fi
      done
    fi
    shift "$keep"
    for entry in "$@"; do printf '/%s\n' "$entry"; done
  } >> .git/info/exclude
fi
PROOFBOX_GITHUB_TOKEN=$token GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$PROOFBOX_GITHUB_TOKEN"; }; f' fetch -q "$url" "+refs/heads/$base:refs/remotes/origin/$base"`;

const PLACE = `set -eu
head=$1; branch=$2; base=$3; url=$4; upstream=$5; bundle=$6; reused=$7
if [ "$bundle" = yes ]; then
  dir=$(mktemp -d)
  cat > "$dir/commits.bundle"
  git fetch -q "$dir/commits.bundle" HEAD
  rm -rf "$dir"
fi
if [ "$reused" = yes ]; then
  if ! git rev-parse -q --verify HEAD >/dev/null 2>&1; then git reset -q "$head"; fi
  if [ -n "$branch" ]; then git checkout -q -B "$branch"; else git checkout -q --detach; fi
  git reset -q "$head"
else
  if [ -n "$branch" ]; then git checkout -q -f -B "$branch" "$head"; else git checkout -q -f --detach "$head"; fi
fi
git remote add origin "$url" 2>/dev/null || git remote set-url origin "$url"
if [ -n "$branch" ] && [ "$upstream" = yes ]; then git branch -q --set-upstream-to="origin/$base" "$branch"; fi`;

export const cloneWorkFolder = Effect.fn("harnessSandbox.cloneWorkFolder")(
  function* (
    rawId: string,
    folder: string,
    repo: GithubRepo,
    token: Redacted.Redacted<string>,
    ignore: ReadonlyArray<string>,
    reused: boolean,
    keep: ReadonlyArray<string>,
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
            [
              "sh",
              "-c",
              FETCH,
              "sh",
              url,
              repo.base,
              keep.length.toString(),
              ...keep,
              ...ignore,
            ],
            Stream.make(new TextEncoder().encode(`${Redacted.value(token)}\n`)),
          );
          if (fetched.code !== 0) {
            const output = yield* CliOutput;
            for (const line of fetched.lines) yield* output.err(line);
            return yield* new CloneRefusedError({
              owner: repo.owner,
              repo: repo.repo,
            });
          }
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
            bundle = yield* fs.readFile(path).pipe(
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
              reused ? "yes" : "no",
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

export const installHarness = Effect.fn("harnessSandbox.installHarness")(
  function* (rawId: string, harness: Harness, version: Option.Option<string>) {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const info = yield* id.provider.get(id);
    const progress = yield* Progress;
    const result = yield* progress.step(
      `installing ${harness.name}`,
      withDeadlinePush(
        id.provider,
        id,
        info,
      )(runKeepingTail(rawId, ["sh", "-c", harness.install(version)])),
    );
    if (result.code !== 0) {
      const output = yield* CliOutput;
      for (const line of result.lines) yield* output.err(line);
      return yield* new HarnessInstallFailedError({
        harness: harness.name,
        code: result.code,
      });
    }
  },
);
