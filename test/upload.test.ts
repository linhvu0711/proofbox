import {
  chmodSync,
  existsSync,
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

  it("a path that changed from a folder to a file syncs", async () => {
    // Given: a Sandbox holding the uploaded folder d/; the Caller replaced
    // d/ with a file d
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
    const folder = makeGitFolder({ committed: { "d/x.txt": "x\n" } });
    const first = await runCli(env, ["upload", id, folder]);
    expect(first.exitCode).toBe(0);
    rmSync(join(folder, "d"), { recursive: true });
    writeFileSync(join(folder, "d"), "file\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 1 file, removed 1 file\n",
    );
    expect(String(readFileSync(join(env.root, name, "home", "d")))).toBe(
      "file\n",
    );
    expect(homeFiles(join(env.root, name, "home"))).toEqual(["d"]);
  });

  it("a path that changed from a file to a folder syncs", async () => {
    // Given: the fixture uploaded once; the Caller's a.txt became a folder
    const { env, id, name, folder } = await uploadOnce();
    rmSync(join(folder, "a.txt"));
    mkdirSync(join(folder, "a.txt"));
    writeFileSync(join(folder, "a.txt", "inner.txt"), "i\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 1 file, removed 1 file\n",
    );
    expect(
      String(readFileSync(join(env.root, name, "home", "a.txt", "inner.txt"))),
    ).toBe("i\n");
  });

  it("a symlink left in the Sandbox does not take an upload outside the Work folder", async () => {
    // Given: the fixture uploaded once; the Sandbox made Work folder path
    // d a symlink to a folder outside the Work folder
    const { env, id, name, folder } = await uploadOnce();
    const linked = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "mkdir -p ../outside && ln -s ../outside d",
    ]);
    expect(linked.exitCode).toBe(0);
    mkdirSync(join(folder, "d"));
    writeFileSync(join(folder, "d", "x.txt"), "x\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then: the link is dropped and a real folder takes the file
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 1 file, removed 0 files\n",
    );
    expect(
      String(readFileSync(join(env.root, name, "home", "d", "x.txt"))),
    ).toBe("x\n");
    expect(readdirSync(join(env.root, name, "outside"))).toEqual([]);
  });

  it("a removed path does not reach outside the Work folder through a symlink", async () => {
    // Given: the fixture plus d/x.txt uploaded; in the Sandbox d became a
    // symlink to an outside folder holding a planted file; the Caller
    // deleted d/x.txt
    const { env, id, name, folder } = await uploadOnce();
    mkdirSync(join(folder, "d"));
    writeFileSync(join(folder, "d", "x.txt"), "x\n");
    const second = await runCli(env, ["upload", id, folder]);
    expect(second.exitCode).toBe(0);
    const tampered = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "rm -rf d && mkdir -p ../outside && ln -s ../outside d && echo planted > ../outside/x.txt",
    ]);
    expect(tampered.exitCode).toBe(0);
    rmSync(join(folder, "d"), { recursive: true });
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then: the link is dropped before the remove, so the planted file stays
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 0 files, removed 1 file\n",
    );
    expect(String(readFileSync(join(env.root, name, "outside", "x.txt")))).toBe(
      "planted\n",
    );
    expect(existsSync(join(env.root, name, "home", "d"))).toBe(false);
  });

  it("a tampered hash list cannot point the sync outside the Work folder", async () => {
    // Given: the fixture uploaded once; the saved hash list holds a path
    // that reaches outside the Work folder, where a file is planted
    const { env, id, name, folder } = await uploadOnce();
    writeFileSync(join(env.root, name, "evil.txt"), "evil\n");
    writeFileSync(
      join(env.root, name, "state", "work-hashes.json"),
      JSON.stringify({
        version: 1,
        files: { "../evil.txt": { sha256: "0", executable: false } },
      }),
    );
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then: the upload refuses rather than remove the outside path
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("escapes the Work folder");
    expect(String(readFileSync(join(env.root, name, "evil.txt")))).toBe(
      "evil\n",
    );
  });

  it("two uploads at once run one after the other", async () => {
    // Given: the fixture uploaded once; a.txt changed so the first upload
    // has a file to send
    const { env, id, folder } = await uploadOnce();
    writeFileSync(join(folder, "a.txt"), "a2\n");
    // When
    const [one, two] = await Promise.all([
      runCli(env, ["upload", id, folder]),
      runCli(env, ["upload", id, folder]),
    ]);
    // Then: both finish; whichever goes second waits out the lock and
    // finds nothing left to send
    expect(one.exitCode).toBe(0);
    expect(two.exitCode).toBe(0);
    expect([one.stderr, two.stderr].sort()).toEqual([
      "proofbox: uploading Work folder\nproofbox: sent 0 files, removed 0 files\n",
      "proofbox: uploading Work folder\nproofbox: sent 1 file, removed 0 files\n",
    ]);
  });

  it("a Work file name that is not UTF-8 refuses the upload", async () => {
    // Given: the fixture uploaded once; an untracked file whose name holds
    // a byte that is not valid UTF-8
    const { env, id, name, folder } = await uploadOnce();
    writeFileSync(
      Buffer.concat([
        Buffer.from(`${folder}/`),
        Buffer.from([0x62, 0x61, 0x64, 0xff]),
      ]),
      "x\n",
    );
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then: the upload refuses rather than silently skip the file
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("not valid UTF-8");
    expect(existsSync(join(env.root, name, "state", "work-hashes.json"))).toBe(
      true,
    );
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

  it("a failed upload leaves no hash list", async () => {
    // Given: the fixture uploaded once; a.txt changed; the Work folder made
    // read-only so the tar step fails halfway
    const { env, id, name, folder } = await uploadOnce();
    writeFileSync(join(folder, "a.txt"), "a2\n");
    const home = join(env.root, name, "home");
    chmodSync(home, 0o500);
    try {
      // When
      const result = await runCli(env, ["upload", id, folder]);
      // Then
      expect(result.exitCode).toBe(125);
      expect(
        existsSync(join(env.root, name, "state", "work-hashes.json")),
      ).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it("an upload over --max-size is refused before anything is sent", async () => {
    // Given: a Sandbox and a git folder with one 2 MB file
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
    const folder = makeGitFolder({
      committed: { "big.bin": "x".repeat(2_000_000) },
    });
    // When
    const result = await runCli(env, [
      "upload",
      id,
      folder,
      "--max-size",
      "1MB",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Work folder is 2.0 MB, over the 1.0 MB limit, so nothing was sent. Git-ignore the big files, or raise the limit with --max-size.\n",
    );
    expect(readdirSync(join(env.root, name, "home"))).toEqual([]);
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
