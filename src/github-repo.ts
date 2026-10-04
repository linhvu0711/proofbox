import { resolve } from "node:path";
import { Command } from "@effect/platform";
import { Effect, Option, Schema, Stream } from "effect";
import { NotGithubRepoError, ProviderError, platformReason } from "./errors.ts";

export const GithubRepo = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  remote: Schema.String,
  base: Schema.String,
  baseCommit: Schema.String,
  head: Schema.String,
  branch: Schema.OptionFromSelf(Schema.String),
  upstream: Schema.Boolean,
  dirty: Schema.Array(Schema.String),
});
export type GithubRepo = typeof GithubRepo.Type;

export const parseGithubRemote = (
  url: string,
): Option.Option<{ readonly owner: string; readonly repo: string }> => {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  return match?.[1] !== undefined && match[2] !== undefined
    ? Option.some({ owner: match[1], repo: match[2] })
    : Option.none();
};

export const readGithubRepo = Effect.fn("githubRepo.readGithubRepo")(function* (
  folder: string,
) {
  folder = resolve(folder);
  const git = (...args: string[]) =>
    Effect.gen(function* () {
      const process = yield* Command.start(
        Command.make("git", ...args).pipe(Command.workingDirectory(folder)),
      );
      const [bytes, code] = yield* Effect.all(
        [
          Stream.runCollect(process.stdout),
          process.exitCode,
          Stream.runDrain(process.stderr),
        ],
        { concurrency: 3 },
      );
      return {
        code,
        text: Buffer.concat(
          [...bytes].map((chunk) => Buffer.from(chunk)),
        ).toString("utf8"),
      };
    }).pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({
            provider: "local",
            reason: platformReason(error),
          }),
      ),
    );
  const bad = (reason: string) => new NotGithubRepoError({ folder, reason });
  if ((yield* git("rev-parse", "--is-inside-work-tree")).code !== 0) {
    return yield* bad("is not a git folder");
  }
  const symbolic = yield* git("symbolic-ref", "-q", "--short", "HEAD");
  const branch =
    symbolic.code === 0
      ? Option.some(symbolic.text.trim())
      : Option.none<string>();
  const remoteConfig = Option.isSome(branch)
    ? yield* git("config", `branch.${branch.value}.remote`)
    : undefined;
  const mergeConfig = Option.isSome(branch)
    ? yield* git("config", `branch.${branch.value}.merge`)
    : undefined;
  const upstream =
    remoteConfig?.code === 0 &&
    mergeConfig?.code === 0 &&
    remoteConfig.text.trim() !== ".";
  const remote = upstream ? remoteConfig.text.trim() : "origin";
  const remoteUrl = yield* git("remote", "get-url", remote);
  const parsed =
    remoteUrl.code === 0
      ? parseGithubRemote(remoteUrl.text.trim())
      : Option.none();
  if (Option.isNone(parsed)) {
    return yield* bad("has no remote on github.com");
  }
  const defaultBranch = upstream
    ? undefined
    : yield* git(
        "symbolic-ref",
        "-q",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      );
  const noBase = () =>
    bad(
      `has no branch on github.com to start from; run git fetch ${remote}, or push this branch`,
    );
  if (!upstream && defaultBranch?.code !== 0) {
    return yield* noBase();
  }
  const base = upstream
    ? mergeConfig.text.trim().replace(/^refs\/heads\//, "")
    : (defaultBranch?.text.trim() ?? "").slice(remote.length + 1);
  const mergeBase = yield* git(
    "merge-base",
    "HEAD",
    `refs/remotes/${remote}/${base}`,
  );
  if (mergeBase.code !== 0) {
    return yield* noBase();
  }
  const head = yield* git("rev-parse", "HEAD");
  const changed = yield* git(
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "HEAD",
  );
  const added = yield* git("ls-files", "-z", "--others", "--exclude-standard");
  return GithubRepo.make({
    ...parsed.value,
    remote,
    base,
    baseCommit: mergeBase.text.trim(),
    head: head.text.trim(),
    branch,
    upstream,
    dirty: [
      ...new Set(
        [...changed.text.split("\0"), ...added.text.split("\0")].filter(
          (path) => path !== "",
        ),
      ),
    ],
  });
});
