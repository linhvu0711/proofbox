import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type CliEnv,
  cleanupEnvs,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./support/cli.ts";

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: folder, encoding: "utf8" });

const makeGithub = (committed = { "a.txt": "a\n" }) => {
  const source = makeGitFolder({ committed });
  const github = mkdtempSync(join(tmpdir(), "proofbox-github-"));
  trackTempDir(github);
  mkdirSync(join(github, "acme"));
  git(source, "clone", "-q", "--bare", source, join(github, "acme", "app.git"));
  const folder = mkdtempSync(join(tmpdir(), "proofbox-caller-"));
  trackTempDir(folder);
  git(folder, "clone", "-q", join(github, "acme", "app.git"), folder);
  git(folder, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  return { folder, github };
};

const loginFile = (env: CliEnv, name: string, value: unknown) => {
  const config = join(env.env.HOME ?? "", ".config", "proofbox");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, `${name}-logins.json`), JSON.stringify(value), {
    mode: 0o600,
  });
};

const createArgs = (folder: string, harness = "claude") => [
  "create",
  "--os",
  "linux",
  "--provider",
  "fake",
  "--harness",
  harness,
  "--work",
  folder,
];

afterEach(cleanupEnvs);

it("create --harness claude with no Harness login stops before the Provider", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  // When
  const result = await runCli(env, createArgs(folder), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr:
      "No Harness login for claude; run proofbox harness login claude. Make one with `claude setup-token`. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
});

it("create --harness claude with an expired Harness login stops before the Provider", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  loginFile(env, "harness", {
    claude: {
      token: "sk-ant-oat01-old",
      expiresAt: "2025-01-01T00:00:00.000Z",
    },
  });
  // When
  const result = await runCli(env, createArgs(folder), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr:
      "The Harness login for claude expired; run proofbox harness login claude. Make one with `claude setup-token`. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
});

it("create --harness claude with no GitHub login for the owner stops before the Provider", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "harness", { claude: { token: "sk-ant-oat01-fake1" } });
  loginFile(env, "github", { other: { token: "github_pat_fake1" } });
  // When
  const result = await runCli(env, createArgs(folder), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr:
      "No GitHub login for acme; run proofbox github login acme with a fine-grained token for acme/app. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
});

it("create --harness outside a git folder stops before the Provider", async () => {
  // Given
  const env = makeEnv();
  const folder = mkdtempSync(join(tmpdir(), "proofbox-plain-"));
  trackTempDir(folder);
  // When
  const result = await runCli(env, createArgs(folder));
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr: `A Harness needs a GitHub repo: ${folder} is not a git folder. Nothing was created.\n`,
  });
  expect(readdirSync(env.root)).toEqual([]);
});

it("create --harness with no github.com remote stops before the Provider", async () => {
  // Given
  const env = makeEnv();
  const folder = makeGitFolder({ committed: { "a.txt": "a\n" } });
  git(folder, "remote", "add", "origin", "https://gitlab.com/acme/app.git");
  // When
  const result = await runCli(env, createArgs(folder));
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr: `A Harness needs a GitHub repo: ${folder} has no remote on github.com. Nothing was created.\n`,
  });
  expect(readdirSync(env.root)).toEqual([]);
});

it("create --harness-version without --harness makes nothing", async () => {
  // Given
  const env = makeEnv();
  // When
  const result = await runCli(env, [
    "create",
    "--os",
    "linux",
    "--provider",
    "fake",
    "--harness-version",
    "2.1.280",
  ]);
  // Then
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr: "--harness-version needs --harness <name>. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
});
