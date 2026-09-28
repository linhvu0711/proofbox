import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, makeGitFolder, runCli } from "./support/cli.ts";

const homeFiles = (home: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(full.slice(home.length + 1));
      }
    }
  };
  walk(home);
  return out.sort();
};

describe("upload", () => {
  afterEach(cleanupEnvs);

  it("a first upload sends tracked and new files and skips git-ignored ones", async () => {
    // Given: a Sandbox and a git folder with committed, untracked, and
    // ignored files
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const folder = makeGitFolder({
      committed: {
        "a.txt": "a\n",
        "src/b.txt": "b\n",
        ".gitignore": "dist/\n",
      },
      untracked: { "new.txt": "n\n", "dist/out.js": "x\n" },
    });
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\n",
    );
    const name = id.replace("fake:", "");
    expect(homeFiles(join(env.root, name, "home"))).toEqual([
      ".gitignore",
      "a.txt",
      "new.txt",
      "src/b.txt",
    ]);
  });

  it("upload of a folder that is not a git repo exits 125 and says so", async () => {
    // Given: a Sandbox and a folder with a file but no git repo
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const name = id.replace("fake:", "");
    const plain = join(env.runtime, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.txt"), "a\n");
    // When
    const result = await runCli(env, ["upload", id, plain]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Upload needs a git folder: ${plain} is not a git folder. Run git init there, or pass a git folder.\n`,
    );
    expect(readdirSync(join(env.root, name, "home"))).toEqual([]);
  });
});
