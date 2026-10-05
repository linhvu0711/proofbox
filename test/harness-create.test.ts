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
import {
  createArgs,
  fakeLogins,
  harnessLoginFile,
  loginFile,
  makeGithub,
} from "./support/harness.ts";

const git = (folder: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: folder, encoding: "utf8" });

afterEach(cleanupEnvs);

it("create renews a file login older than 7 days and sends the renewed one", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  harnessLoginFile(
    env,
    "fake-file",
    '{"last_refresh":"2020-01-01T00:00:00Z","renewals":0}',
  );
  const created = await runCli(env, createArgs(folder, "fake-file"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const saved = readFileSync(
    join(
      env.env.HOME ?? "",
      ".config",
      "proofbox",
      "harness-logins",
      "fake-file",
      "auth.json",
    ),
    "utf8",
  );
  const file = await runCli(env, [
    "exec",
    created.stdout.trim(),
    "--",
    "cat",
    ".fake-harness/auth.json",
  ]);
  const login: unknown = JSON.parse(saved);
  expect({
    code: created.exitCode,
    login,
    same: saved === file.stdout,
  }).toMatchObject({ code: 0, login: { renewals: 1 }, same: true });
});

it("a file login that cannot be renewed stops create before the Provider", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  const text =
    '{"last_refresh":"2020-01-01T00:00:00Z","renewals":0,"fail_renew":true}';
  harnessLoginFile(env, "fake-file", text);
  const result = await runCli(env, createArgs(folder, "fake-file"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr:
      "could not renew the Harness login for fake-file; run proofbox harness login fake-file. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
  expect(
    readFileSync(
      join(
        env.env.HOME ?? "",
        ".config",
        "proofbox",
        "harness-logins",
        "fake-file",
        "auth.json",
      ),
      "utf8",
    ),
  ).toBe(text);
});

it("create --harness with a file login writes it owner-only and out of git", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  const text = `{"last_refresh":"${new Date(Date.now() - 3_600_000).toISOString()}","renewals":0}`;
  harnessLoginFile(env, "fake-file", text);
  const created = await runCli(env, createArgs(folder, "fake-file"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const file = await runCli(env, [
    "exec",
    id,
    "--",
    "cat",
    ".fake-harness/auth.json",
  ]);
  const mode = await runCli(env, [
    "exec",
    id,
    "--",
    "perl",
    "-e",
    'printf "%o\\n", (stat shift)[2] & 0777',
    ".fake-harness/auth.json",
  ]);
  const status = await runCli(env, [
    "exec",
    id,
    "--",
    "git",
    "status",
    "--porcelain",
  ]);
  expect({
    code: created.exitCode,
    file: file.stdout,
    mode: mode.stdout,
    status: status.stdout,
  }).toEqual({ code: 0, file: text, mode: "600\n", status: "" });
});

it("a Snapshot saved by create --harness holds no login file", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  const text = `{"last_refresh":"${new Date(Date.now() - 3_600_000).toISOString()}","renewals":0,"mark":"login-mark-5e3a"}`;
  harnessLoginFile(env, "fake-file", text);
  const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
  trackTempDir(dir);
  const script = join(env.env.HOME ?? "", "setup.sh");
  writeFileSync(script, "#!/bin/sh\necho ran > ran.txt\n");
  const created = await runCli(
    env,
    [...createArgs(folder, "fake-file"), "--setup", script],
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
  expect({
    code: created.exitCode,
    leaked: /login-mark-5e3a/.test(contents),
  }).toEqual({ code: 0, leaked: false });
  expect(readdirSync(dir)).toHaveLength(1);
});

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

const profileFile = (
  env: CliEnv,
  path: string,
  content: string,
  harness = "fake",
) => {
  const root = join(
    env.env.HOME ?? "",
    ".config",
    "proofbox",
    "harness",
    harness,
  );
  mkdirSync(join(root, "skills", "s"), { recursive: true });
  writeFileSync(join(root, path), content);
};

it("a Harness profile auth.json never overwrites the login file", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  const text = `{"last_refresh":"${new Date(Date.now() - 3_600_000).toISOString()}","renewals":0}`;
  harnessLoginFile(env, "fake-file", text);
  profileFile(
    env,
    "auth.json",
    '{"last_refresh":"2999-01-01T00:00:00Z","renewals":99}',
    "fake-file",
  );
  profileFile(env, "AGENTS.md", "# rules\n", "fake-file");
  const created = await runCli(env, createArgs(folder, "fake-file"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  const id = created.stdout.trim();
  const file = await runCli(env, [
    "exec",
    id,
    "--",
    "cat",
    ".fake-harness/auth.json",
  ]);
  const rules = await runCli(env, [
    "exec",
    id,
    "--",
    "cat",
    ".fake-harness/AGENTS.md",
  ]);
  expect({
    code: created.exitCode,
    file: file.stdout,
    rules: rules.stdout,
  }).toEqual({ code: 0, file: text, rules: "# rules\n" });
});

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

it.each(["branch", "detached HEAD"])(
  "a Harness create that reuses a Snapshot from a plain create puts the branch on top and hides no repo folder (%s)",
  async (head) => {
    // Given
    const env = makeEnv();
    const { folder, github } = makeGithub({ "src/a.txt": "a\n" });
    if (head === "detached HEAD") git(folder, "checkout", "-q", "--detach");
    fakeLogins(env);
    const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
    trackTempDir(dir);
    const script = join(env.env.HOME ?? "", "setup.sh");
    writeFileSync(script, "#!/bin/sh\necho ran > ran.txt\n");
    const options = {
      set: {
        PROOFBOX_GITHUB_URL: `file://${github}`,
        PROOFBOX_FAKE_SNAPSHOTS: dir,
      },
    };
    // When
    const first = await runCli(
      env,
      [
        "create",
        "--os",
        "linux",
        "--provider",
        "fake",
        "--work",
        folder,
        "--setup",
        script,
      ],
      options,
    );
    const second = await runCli(
      env,
      [...createArgs(folder, "fake"), "--setup", script],
      options,
    );
    const id = second.stdout.trim();
    const log = await runCli(env, [
      "exec",
      id,
      "--",
      "git",
      "log",
      "-1",
      "--format=%s",
    ]);
    const status = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "echo n > src/new.txt && git status --porcelain",
    ]);
    // Then
    expect({
      first: first.exitCode,
      second: second.exitCode,
      reused: second.stderr.includes("proofbox: Snapshot reused, Fingerprint "),
      log: log.stdout,
      status: status.stdout,
    }).toEqual({
      first: 0,
      second: 0,
      reused: true,
      log: "init\n",
      status: "?? src/new.txt\n",
    });
  },
);

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

it("create --harness codex with no Codex login stops before the Provider", async () => {
  const env = makeEnv();
  const { folder, github } = makeGithub();
  loginFile(env, "github", { acme: { token: "github_pat_fake1" } });
  const result = await runCli(env, createArgs(folder, "codex"), {
    set: { PROOFBOX_GITHUB_URL: `file://${github}` },
  });
  expect(result).toEqual({
    exitCode: 125,
    stdout: "",
    stderr:
      "No Harness login for codex; run proofbox harness login codex. It signs in with your ChatGPT plan. Nothing was created.\n",
  });
  expect(readdirSync(env.root)).toEqual([]);
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
