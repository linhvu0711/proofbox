import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const makeGithub = (committed: Record<string, string> = { "a.txt": "a\n" }) => {
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

const fakeLogins = (env: CliEnv) => {
  loginFile(env, "harness", { fake: { token: "fake-tok-1" } });
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
};

it("create --harness prints a step for the clone and one for the install", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  fakeLogins(env);
  // When
  const result = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  // Then
  expect({ code: result.exitCode, stderr: result.stderr }).toEqual({
    code: 0,
    stderr:
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: cloning acme/app\nproofbox: uploading Work folder\nproofbox: sent 0 files, removed 0 files\nproofbox: installing fake\nproofbox: sending 2 Secrets\n",
  });
});

const profileFile = (env: CliEnv, path: string, content: string) => {
  const root = join(
    env.env.HOME ?? "",
    ".config",
    "proofbox",
    "harness",
    "fake",
  );
  mkdirSync(join(root, "skills", "s"), { recursive: true });
  writeFileSync(join(root, path), content);
};

it("create --harness copies the Harness profile into the Harness home", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  fakeLogins(env);
  profileFile(env, "AGENTS.md", "# rules\n");
  profileFile(env, "skills/s/SKILL.md", "skill\n");
  // When
  const created = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const rules = await runCli(env, [
    "exec",
    id,
    "--",
    "cat",
    ".fake-harness/AGENTS.md",
  ]);
  const skill = await runCli(env, [
    "exec",
    id,
    "--",
    "cat",
    ".fake-harness/skills/s/SKILL.md",
  ]);
  const status = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "status",
    "--porcelain",
  ]);
  // Then
  expect({
    code: created.exitCode,
    copying: created.stderr.includes("proofbox: copying the Harness profile\n"),
    rules: rules.stdout,
    skill: skill.stdout,
    status: status.stdout,
  }).toEqual({
    code: 0,
    copying: true,
    rules: "# rules\n",
    skill: "skill\n",
    status: "",
  });
});

it("create --harness with no Harness profile still works", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  fakeLogins(env);
  // When
  const created = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const result = await runCli(env, [
    "exec",
    created.stdout.trim(),
    "--",
    "sh",
    "-c",
    "if [ -e .fake-harness ]; then echo there; else echo none; fi",
  ]);
  // Then
  expect({
    code: created.exitCode,
    copying: created.stderr.includes("Harness profile"),
    value: result.stdout,
  }).toEqual({ code: 0, copying: false, value: "none\n" });
});

it("a Snapshot saved by create --harness holds no login and no profile file", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "harness", { fake: { token: "fake-tok-9d2b" } });
  loginFile(env, "github", { acme: { token: "github_pat_9d2b" } });
  profileFile(env, "AGENTS.md", "profile-mark-7c1e\n");
  const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
  trackTempDir(dir);
  const script = join(env.env.HOME ?? "", "setup.sh");
  writeFileSync(script, "#!/bin/sh\necho ran > ran.txt\n");
  // When
  const created = await runCli(
    env,
    [...createArgs(folder, "fake"), "--setup", script],
    {
      set: {
        PROOFBOX_GITHUB_URL: `file://${github}`,
        PROOFBOX_FAKE_SNAPSHOTS: dir,
      },
    },
  );
  const paths = readdirSync(dir, { recursive: true, encoding: "utf8" });
  const contents = paths
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => readFileSync(join(dir, path), "utf8"))
    .join("\n");
  // Then
  expect({
    code: created.exitCode,
    saved: created.stderr.includes("proofbox: Snapshot saved, Fingerprint "),
    count: readdirSync(dir).length,
    leaked: /fake-tok-9d2b|github_pat_9d2b|profile-mark-7c1e/.test(contents),
    profile: paths.some((path) => path.includes(".fake-harness")),
  }).toEqual({ code: 0, saved: true, count: 1, leaked: false, profile: false });
});

it("a reused Snapshot keeps what the Setup script wrote to a tracked file", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub({ "a.txt": "original\n" });
  fakeLogins(env);
  const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
  trackTempDir(dir);
  const script = join(env.env.HOME ?? "", "setup.sh");
  writeFileSync(script, "#!/bin/sh\nprintf 'setup changed\\n' > a.txt\n");
  const args = [...createArgs(folder, "fake"), "--setup", script];
  const options = {
    set: {
      PROOFBOX_GITHUB_URL: `file://${github}`,
      PROOFBOX_FAKE_SNAPSHOTS: dir,
    },
  };
  // When
  const first = await runCli(env, args, options);
  const second = await runCli(env, args, options);
  const id = second.stdout.trim();
  const file = await runCli(env, ["exec", id, "--", "cat", "a.txt"]);
  const log = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "log",
    "-1",
    "--format=%s",
  ]);
  // Then
  expect({
    first: first.exitCode,
    second: second.exitCode,
    reused: second.stderr.includes("proofbox: Snapshot reused, Fingerprint "),
    file: file.stdout,
    log: log.stdout,
  }).toEqual({
    first: 0,
    second: 0,
    reused: true,
    file: "setup changed\n",
    log: "init\n",
  });
});

it("a command after create --harness sees the Harness login and GH_TOKEN", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  fakeLogins(env);
  const path = join(env.env.HOME ?? "", "secrets.env");
  writeFileSync(path, "GH_TOKEN=from-env\nAPI_TOKEN=tok-5f2a9c\n", {
    mode: 0o600,
  });
  // When
  const created = await runCli(
    env,
    [...createArgs(folder, "fake"), "--env-file", path],
    { set: { PROOFBOX_GITHUB_URL: `file://${github}` } },
  );
  const result = await runCli(env, [
    "exec",
    created.stdout.trim(),
    "--",
    "sh",
    "-c",
    'printf "%s|%s|%s" "$PROOFBOX_FAKE_HARNESS_TOKEN" "$GH_TOKEN" "$API_TOKEN"',
  ]);
  // Then
  expect({
    code: created.exitCode,
    sending: created.stderr.includes("proofbox: sending 4 Secrets\n"),
    leaked: /fake-tok-1|github_pat_fake1/.test(created.stderr),
    value: result.stdout,
  }).toEqual({
    code: 0,
    sending: true,
    leaked: false,
    value: "fake-tok-1|github_pat_fake1|tok-5f2a9c",
  });
});

it("a clone GitHub refuses fails create, deletes the Sandbox, and names the owner and the repo", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  git(
    folder,
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/gone.git",
  );
  fakeLogins(env);
  // When
  const result = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  // Then
  expect({
    code: result.exitCode,
    out: result.stdout,
    cloning: result.stderr.includes("proofbox: cloning acme/gone\n"),
    message: result.stderr.endsWith(
      "GitHub refused the clone of acme/gone; git's lines are above. Check that the GitHub login for acme can read acme/gone and has not expired, then run proofbox github login acme and create again. This Sandbox was deleted.\n",
    ),
    sandboxes: readdirSync(env.root),
  }).toEqual({
    code: 125,
    out: "",
    cloning: true,
    message: true,
    sandboxes: [],
  });
});

it("create --harness puts the Caller's uncommitted changes, deletions, and new files on top", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub({ "a.txt": "a\n", "b.txt": "b\n" });
  writeFileSync(join(folder, "a.txt"), "a2\n");
  rmSync(join(folder, "b.txt"));
  writeFileSync(join(folder, "n.txt"), "n\n");
  fakeLogins(env);
  // When
  const created = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const changed = await runCli(env, ["exec", id, "--", "cat", "a.txt"]);
  const deleted = await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    "if [ -e b.txt ]; then echo there; else echo gone; fi",
  ]);
  const added = await runCli(env, ["exec", id, "--", "cat", "n.txt"]);
  const status = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "status",
    "--porcelain",
  ]);
  // Then
  expect({
    code: created.exitCode,
    sent: created.stderr.includes("proofbox: sent 2 files, removed 1 file\n"),
    changed: changed.stdout,
    deleted: deleted.stdout,
    added: added.stdout,
    status: status.stdout,
  }).toEqual({
    code: 0,
    sent: true,
    changed: "a2\n",
    deleted: "gone\n",
    added: "n\n",
    status: " M a.txt\n D b.txt\n?? n.txt\n",
  });
});

it("create --harness from a subfolder of the repo uses the whole repo", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub({ "sub/a.txt": "a\n" });
  writeFileSync(join(folder, "sub", "a.txt"), "a2\n");
  writeFileSync(join(folder, "sub", "new.txt"), "n\n");
  fakeLogins(env);
  // When
  const created = await runCli(env, createArgs(join(folder, "sub"), "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const changed = await runCli(env, ["exec", id, "--", "cat", "sub/a.txt"]);
  const added = await runCli(env, ["exec", id, "--", "cat", "sub/new.txt"]);
  const misplaced = await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    "if [ -e new.txt ]; then echo there; else echo none; fi",
  ]);
  // Then
  expect({
    code: created.exitCode,
    changed: changed.stdout,
    added: added.stdout,
    misplaced: misplaced.stdout,
  }).toEqual({ code: 0, changed: "a2\n", added: "n\n", misplaced: "none\n" });
});

it("create --harness puts the Caller's unpushed commit on top of the branch from GitHub", async () => {
  // Given
  const env = makeEnv();
  const { folder, github } = makeGithub();
  git(folder, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  writeFileSync(join(folder, "c.txt"), "c\n");
  git(folder, "add", ".");
  git(
    folder,
    "-c",
    "user.name=proofbox",
    "-c",
    "user.email=test@proofbox.invalid",
    "commit",
    "-qm",
    "local: add c.txt",
  );
  fakeLogins(env);
  // When
  const created = await runCli(env, createArgs(folder, "fake"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const log = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "log",
    "-2",
    "--format=%s",
  ]);
  const status = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "status",
    "--porcelain",
  ]);
  const token = await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    "if grep -rqs github_pat_fake1 .git; then echo found; else echo clean; fi",
  ]);
  // Then
  expect({
    code: created.exitCode,
    cloning: created.stderr.includes("proofbox: cloning acme/app\n"),
    log: log.stdout,
    status: status.stdout,
    token: token.stdout,
  }).toEqual({
    code: 0,
    cloning: true,
    log: "local: add c.txt\ninit\n",
    status: "",
    token: "clean\n",
  });
});

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
