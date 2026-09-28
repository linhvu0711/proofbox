import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  const uploadOnce = async () => {
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
    const first = await runCli(env, ["upload", id, folder]);
    expect(first.exitCode).toBe(0);
    return { env, id, name: id.replace("fake:", ""), folder };
  };

  it("a second upload sends only the changed file", async () => {
    // Given: the fixture uploaded once; the Sandbox's copy of src/b.txt
    // changed so a resend would undo it; the Caller's a.txt changed
    const { env, id, name, folder } = await uploadOnce();
    writeFileSync(join(env.root, name, "home", "src", "b.txt"), "sandbox\n");
    writeFileSync(join(folder, "a.txt"), "a2\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 1 file, removed 0 files\n",
    );
    expect(String(readFileSync(join(env.root, name, "home", "a.txt")))).toBe(
      "a2\n",
    );
    expect(
      String(readFileSync(join(env.root, name, "home", "src", "b.txt"))),
    ).toBe("sandbox\n");
  });

  it("a file deleted by the Caller is removed on the next upload", async () => {
    // Given: the fixture uploaded once; new.txt and src/b.txt deleted in the
    // folder (not staged)
    const { env, id, name, folder } = await uploadOnce();
    rmSync(join(folder, "new.txt"));
    rmSync(join(folder, "src", "b.txt"));
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 0 files, removed 2 files\n",
    );
    expect(homeFiles(join(env.root, name, "home"))).toEqual([
      ".gitignore",
      "a.txt",
    ]);
  });

  it("an upload with no change sends nothing", async () => {
    // Given: the fixture uploaded once
    const { env, id, folder } = await uploadOnce();
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 0 files, removed 0 files\n",
    );
  });

  it("an upload with no hash list sends every file again", async () => {
    // Given: the fixture uploaded once; the saved hash list deleted; the
    // Sandbox's a.txt changed so a resend restores it
    const { env, id, name, folder } = await uploadOnce();
    rmSync(join(env.root, name, "state", "work-hashes.json"));
    writeFileSync(join(env.root, name, "home", "a.txt"), "partial\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\n",
    );
    expect(String(readFileSync(join(env.root, name, "home", "a.txt")))).toBe(
      "a\n",
    );
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
