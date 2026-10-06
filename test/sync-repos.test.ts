import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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

const script = fileURLToPath(
  new URL("../scripts/sync-repos.sh", import.meta.url),
);
const made: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-sync-"));
  made.push(dir);
  return dir;
};

const git = (dir: string, ...args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=proofbox",
      "-c",
      "user.email=test@proofbox.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir },
  );

// A folder holding the sync script and a manifest with one library, a local
// git repo tagged v1.
const makeRoot = () => {
  const lib = tempDir();
  writeFileSync(join(lib, "package.json"), "{}");
  git(lib, "init", "-q");
  git(lib, "add", ".");
  git(lib, "commit", "-qm", "init");
  git(lib, "tag", "v1");
  const root = tempDir();
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "repos"));
  copyFileSync(script, join(root, "scripts/sync-repos.sh"));
  writeFileSync(
    join(root, "repos/README.md"),
    `| lib | package | repo | ref | version_file |\n| --- | --- | --- | --- | --- |\n| demo | demo | file://${lib}/ | v1 | package.json |\n`,
  );
  return root;
};

const sync = (root: string) => {
  const { EMBED_SOURCE_SKIP: _, ...env } = process.env;
  return execFileSync("bash", [join(root, "scripts/sync-repos.sh")], {
    env,
    encoding: "utf8",
  });
};

describe("sync-repos", () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a folder with no .git skips the source sync", () => {
    // Given: a manifest with one library, and no .git
    const root = makeRoot();
    // When
    const stdout = sync(root);
    // Then
    expect({ stdout, fetched: existsSync(join(root, "repos/demo")) }).toEqual({
      stdout: "sync-repos: not a git checkout, skipping\n",
      fetched: false,
    });
  });

  it("a git checkout fetches each library at its tag", () => {
    // Given: the same folder, made a git checkout
    const root = makeRoot();
    git(root, "init", "-q");
    // When
    const stdout = sync(root);
    // Then
    expect({
      fetching: stdout.includes("sync-repos: fetching demo at v1"),
      ref: readFileSync(join(root, "repos/demo/.embed-source-ref"), "utf8"),
    }).toEqual({ fetching: true, ref: "v1\n" });
  });
});
