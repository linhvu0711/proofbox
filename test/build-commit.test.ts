import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommit } from "../scripts/build-commit.ts";

const made: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-commit-"));
  made.push(dir);
  return dir;
};

const writeArchiveFile = (dir: string) => {
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/archive-commit.txt"), "$Format:%H$\n");
};

// A repo of only the archive file and its .gitattributes, committed at a
// fixed time by a fixed author, so its commit is always 3995bc5f8….
const makeRepo = () => {
  const dir = tempDir();
  writeArchiveFile(dir);
  writeFileSync(
    join(dir, ".gitattributes"),
    "scripts/archive-commit.txt export-subst\n",
  );
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=proofbox",
      "-c",
      "user.email=test@proofbox.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: dir, env },
  );
  return dir;
};

describe("build commit", () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a GitHub archive builds with the commit it filled in", () => {
    // Given: the repo's archive, unpacked into a folder with no .git
    const repo = makeRepo();
    const out = tempDir();
    execFileSync("git", ["archive", "-o", join(out, "a.tar"), "HEAD"], {
      cwd: repo,
    });
    execFileSync("tar", ["-xf", "a.tar"], { cwd: out });
    // When
    const commit = buildCommit(out);
    // Then
    expect(commit).toBe("3995bc5");
  });

  it("a git checkout builds with its short commit", () => {
    // Given: the repo itself, its archive file not filled in
    const repo = makeRepo();
    // When
    const commit = buildCommit(repo);
    // Then
    expect(commit).toBe("3995bc5");
  });

  it("a folder with neither builds with no commit", () => {
    // Given: the archive file not filled in, and no .git
    const dir = tempDir();
    writeArchiveFile(dir);
    // When
    const commit = buildCommit(dir);
    // Then
    expect(commit).toBeUndefined();
  });
});
