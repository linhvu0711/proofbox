import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliEnv,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./cli.ts";

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: folder, encoding: "utf8" });

export const makeGithub = (
  committed: Record<string, string> = { "a.txt": "a\n" },
) => {
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

export const loginFile = (env: CliEnv, name: string, value: unknown) => {
  const config = join(env.env.HOME ?? "", ".config", "proofbox");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, `${name}-logins.json`), JSON.stringify(value), {
    mode: 0o600,
  });
};

export const harnessLoginFile = (env: CliEnv, name: string, text: string) => {
  const dir = join(
    env.env.HOME ?? "",
    ".config",
    "proofbox",
    "harness-logins",
    name,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), text, { mode: 0o600 });
};

export const createArgs = (folder: string, harness = "claude") => [
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

export const fakeLogins = (env: CliEnv) => {
  loginFile(env, "harness", { fake: { token: "fake-tok-1" } });
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
};

export const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" });
export const containers: string[] = [];

export const fixture = (harness = "claude") => {
  const env = makeEnv({ docker: true });
  const home = mkdtempSync(join(tmpdir(), "proofbox-harness-home-"));
  const folder = mkdtempSync(join(tmpdir(), "proofbox-harness-work-"));
  trackTempDir(home);
  trackTempDir(folder);
  const config = join(home, ".config", "proofbox");
  mkdirSync(join(config, "harness", harness), { recursive: true });
  writeFileSync(
    join(config, "harness-logins.json"),
    JSON.stringify({ [harness]: { token: "sk-ant-oat01-test" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(config, "github-logins.json"),
    JSON.stringify({ octocat: { token: "github_pat_test" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(
      config,
      "harness",
      harness,
      harness === "claude" ? "CLAUDE.md" : "AGENTS.md",
    ),
    "# sandbox rules\n",
  );
  execFileSync("git", [
    "clone",
    "-q",
    "https://github.com/octocat/Hello-World.git",
    folder,
  ]);
  writeFileSync(join(folder, "note.txt"), "note\n");
  execFileSync("git", ["add", "note.txt"], { cwd: folder });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=proofbox",
      "-c",
      "user.email=test@proofbox.invalid",
      "commit",
      "-qm",
      "local: add note.txt",
    ],
    { cwd: folder },
  );
  appendFileSync(join(folder, "README"), "changed\n");
  const settings = {
    set: { HOME: home, DOCKER_CONFIG: join(homedir(), ".docker") },
  };
  const create = async (extra: string[] = []) => {
    const result = await runCli(
      env,
      [
        "create",
        "--os",
        "linux",
        "--provider",
        "docker",
        "--harness",
        harness,
        "--work",
        folder,
        ...extra,
      ],
      settings,
    );
    const id = result.stdout.trim();
    if (/^docker:[a-z0-9]{6}$/.test(id))
      containers.push(`proofbox-${id.slice(7)}`);
    return result;
  };
  const exec = (id: string, ...argv: string[]) =>
    runCli(env, ["exec", id, "--", ...argv], settings);
  return { create, exec, env, folder, settings };
};
