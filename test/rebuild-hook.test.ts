import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scripts = ["rebuild.sh", "install-hooks.sh"];
const scriptPath = (name: string) =>
  fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const made: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-rebuild-"));
  made.push(dir);
  return dir;
};

// A fake pnpm logs each call with the commit it ran at. The user's own git
// config stays out, so its hooks and settings cannot change a result.
const makeEnv = (failBuild: boolean) => {
  const bin = tempDir();
  const log = join(bin, "pnpm.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\necho "$* @ $(git log -1 --format=%s)" >> "${log}"\n${
      failBuild ? '[ "$*" = "run build" ] && exit 1\n' : ""
    }exit 0\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { env, log };
};

const gitArgs = (args: ReadonlyArray<string>) => [
  "-c",
  "user.name=proofbox",
  "-c",
  "user.email=test@proofbox.invalid",
  "-c",
  "commit.gpgsign=false",
  ...args,
];

// An upstream repo holding both scripts, committed as `one`, and a clone of
// it with install-hooks.sh run in it.
const makeClone = (failBuild = false) => {
  const { env, log } = makeEnv(failBuild);
  const git = (dir: string, ...args: ReadonlyArray<string>) =>
    spawnSync("git", gitArgs(args), { cwd: dir, env, encoding: "utf8" });
  const upstream = tempDir();
  mkdirSync(join(upstream, "scripts"));
  for (const name of scripts) {
    copyFileSync(scriptPath(name), join(upstream, "scripts", name));
  }
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "one");
  const clone = join(tempDir(), "clone");
  git(upstream, "clone", "-q", upstream, clone);
  execFileSync("bash", ["scripts/install-hooks.sh"], { cwd: clone, env });
  const readLog = () => readFileSync(log, "utf8");
  const clearLog = () => writeFileSync(log, "");
  return { git, upstream, clone, env, readLog, clearLog };
};

describe("rebuild hook", () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git pull installs and builds at the new commit", () => {
    // Given: a clone with the hooks on, and a new upstream commit `two`
    const { git, upstream, clone, readLog } = makeClone();
    git(upstream, "commit", "--allow-empty", "-qm", "two");
    // When
    const pull = git(clone, "pull", "-q", "--no-rebase");
    // Then
    expect({
      log: readLog(),
      built: `${pull.stdout}${pull.stderr}`.includes("rebuild: built dist/"),
    }).toEqual({
      log: "install --frozen-lockfile @ two\nrun build @ two\n",
      built: true,
    });
  });

  it("a rebase pull over a local commit builds once, at the rebased commit", () => {
    // Given: a local commit `local`, and a new upstream commit `two`
    const { git, upstream, clone, readLog } = makeClone();
    git(clone, "commit", "--allow-empty", "-qm", "local");
    git(upstream, "commit", "--allow-empty", "-qm", "two");
    // When
    git(clone, "pull", "-q", "--rebase");
    // Then
    expect(readLog()).toBe(
      "install --frozen-lockfile @ local\nrun build @ local\n",
    );
  });

  it("a branch switch builds at that branch's commit", () => {
    // Given: branch `other` holding commit `side`, and main checked out
    const { git, clone, readLog, clearLog } = makeClone();
    git(clone, "switch", "-q", "-c", "other");
    git(clone, "commit", "--allow-empty", "-qm", "side");
    git(clone, "switch", "-q", "main");
    clearLog();
    // When
    git(clone, "switch", "-q", "other");
    // Then
    expect(readLog()).toBe(
      "install --frozen-lockfile @ side\nrun build @ side\n",
    );
  });

  it("a switch that keeps the commit, or an amend, builds nothing", () => {
    // Given: a clone with the hooks on
    const { git, clone, readLog, clearLog } = makeClone();
    clearLog();
    // When
    git(clone, "switch", "-q", "-c", "same");
    git(clone, "commit", "--amend", "-q", "--no-edit", "--allow-empty");
    // Then
    expect(readLog()).toBe("");
  });

  it("a linked worktree installs and builds nothing", () => {
    // Given: a clone with the hooks on, and a new upstream commit `two`
    const { git, upstream, clone, readLog, clearLog } = makeClone();
    clearLog();
    // When
    git(clone, "worktree", "add", "-q", "../wt", "-b", "wt");
    git(upstream, "commit", "--allow-empty", "-qm", "two");
    git(join(clone, "../wt"), "pull", "-q", "--no-rebase", "origin", "main");
    // Then
    expect(readLog()).toBe("");
  });

  it("install-hooks twice leaves three hook entries", () => {
    // Given: a clone with the hooks on
    const { git, clone, env } = makeClone();
    // When
    execFileSync("bash", ["scripts/install-hooks.sh"], { cwd: clone, env });
    const entries = git(
      clone,
      "config",
      "--get-regexp",
      "^hook\\.proofbox-rebuild-",
    ).stdout;
    // Then
    expect(entries).toBe(
      [
        "hook.proofbox-rebuild-merge.command test ! -f scripts/rebuild.sh || bash scripts/rebuild.sh post-merge",
        "hook.proofbox-rebuild-merge.event post-merge",
        "hook.proofbox-rebuild-checkout.command test ! -f scripts/rebuild.sh || bash scripts/rebuild.sh post-checkout",
        "hook.proofbox-rebuild-checkout.event post-checkout",
        "hook.proofbox-rebuild-rewrite.command test ! -f scripts/rebuild.sh || bash scripts/rebuild.sh post-rewrite",
        "hook.proofbox-rebuild-rewrite.event post-rewrite",
        "",
      ].join("\n"),
    );
  });

  it("install-hooks in a folder with no .git skips", () => {
    // Given: the script in a folder with no .git
    const root = tempDir();
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      scriptPath("install-hooks.sh"),
      join(root, "scripts/install-hooks.sh"),
    );
    // When
    const stdout = execFileSync("bash", ["scripts/install-hooks.sh"], {
      cwd: root,
      encoding: "utf8",
    });
    // Then
    expect(stdout).toBe("install-hooks: not a git checkout, skipping\n");
  });
});
