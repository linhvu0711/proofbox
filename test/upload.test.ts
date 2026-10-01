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
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Layer, Ref } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import { readWorkFolder, sendWorkFolder } from "../src/commands/upload.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import {
  type CliEnv,
  cleanupEnvs,
  makeEnv,
  makeGitFolder,
  runCli,
} from "./support/cli.ts";

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

const grewMessage =
  "A Work file grew while uploading, so the upload stopped past the 1.0 MB limit. Run it again, or raise the limit with --max-size.";

// In-process upload services on the fake Provider under env.root; keeper
// picks the Keeper socket path or the direct path.
const uploadLayers = (env: CliEnv, keeper: "socket" | "direct") => {
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([
      [
        "fake",
        providerEntry(makeFakeProvider({ root: env.root, watch: "none" })),
      ],
    ]),
  );
  const base = Layer.mergeAll(
    NodeContext.layer,
    CliOutput.Test,
    providers,
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
      }),
    ),
  );
  return (
    keeper === "socket" ? KeeperClient.Default : KeeperClient.Direct
  ).pipe(Layer.provideMerge(base));
};

const withRuntime = (env: CliEnv) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", env.runtime]])),
  );

// A git folder whose big.bin passed a 1 MB check at 500 kB, then grew to
// 5 MB before the send.
const grownFolder = Effect.gen(function* () {
  const folder = makeGitFolder({
    committed: { "a.txt": "a\n", "big.bin": "x".repeat(500_000) },
  });
  const files = yield* readWorkFolder(folder, 1_000_000);
  writeFileSync(join(folder, "big.bin"), "x".repeat(5_000_000));
  return { folder, files };
});

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

  it("a cleared symlink ancestor resends the siblings it carried away", async () => {
    // Given: the fixture plus d/x.txt and d/y.txt uploaded; in the Sandbox
    // d became a symlink to an outside folder; the Caller changed d/x.txt
    const { env, id, name, folder } = await uploadOnce();
    mkdirSync(join(folder, "d"));
    writeFileSync(join(folder, "d", "x.txt"), "x\n");
    writeFileSync(join(folder, "d", "y.txt"), "y\n");
    const second = await runCli(env, ["upload", id, folder]);
    expect(second.exitCode).toBe(0);
    const linked = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "rm -rf d && mkdir -p ../outside && ln -s ../outside d",
    ]);
    expect(linked.exitCode).toBe(0);
    writeFileSync(join(folder, "d", "x.txt"), "x2\n");
    // When
    const result = await runCli(env, ["upload", id, folder]);
    // Then: dropping the link removed d/y.txt too, so it is resent even
    // though only d/x.txt changed
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 2 files, removed 0 files\n",
    );
    expect(
      String(readFileSync(join(env.root, name, "home", "d", "x.txt"))),
    ).toBe("x2\n");
    expect(
      String(readFileSync(join(env.root, name, "home", "d", "y.txt"))),
    ).toBe("y\n");
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

  it("a Work file name that is not UTF-8 refuses the upload", async (ctx) => {
    // Given: the fixture uploaded once; an untracked file whose name holds
    // a byte that is not valid UTF-8
    const { env, id, name, folder } = await uploadOnce();
    try {
      writeFileSync(
        Buffer.concat([
          Buffer.from(`${folder}/`),
          Buffer.from([0x62, 0x61, 0x64, 0xff]),
        ]),
        "x\n",
      );
    } catch (error) {
      // Some file systems, like APFS on macOS, refuse such a name, so no
      // Work folder there can hold one.
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EILSEQ"
      ) {
        ctx.skip("the file system refuses a name that is not UTF-8");
      }
      throw error;
    }
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

  it.scopedLive(
    "a grown Work file fails the upload with its own message through the Keeper",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox with its Keeper running; big.bin grew after the
        // size check
        const env = makeEnv();
        const created = yield* Effect.promise(() =>
          runCli(env, ["create", "--os", "linux", "--provider", "fake"]),
        );
        const id = created.stdout.trim();
        const { folder, files } = yield* grownFolder;
        // When
        const error = yield* Effect.flip(
          sendWorkFolder(id, folder, files, 1_000_000).pipe(
            Effect.provide(uploadLayers(env, "socket")),
            withRuntime(env),
          ),
        );
        // Then
        expect(error.message).toBe(grewMessage);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive(
    "an upload after a stopped one sends every Work file again",
    () =>
      Effect.gen(function* () {
        // Given: a.txt and big.bin uploaded; big.bin changed, then grew after
        // the next size check, and that send stopped
        const env = makeEnv();
        const created = yield* Effect.promise(() =>
          runCli(env, ["create", "--os", "linux", "--provider", "fake"]),
        );
        const id = created.stdout.trim();
        const folder = makeGitFolder({
          committed: { "a.txt": "a\n", "big.bin": "y".repeat(400_000) },
        });
        const first = yield* Effect.promise(() =>
          runCli(env, ["upload", id, folder]),
        );
        expect(first.exitCode).toBe(0);
        writeFileSync(join(folder, "big.bin"), "x".repeat(500_000));
        const files = yield* readWorkFolder(folder, 1_000_000);
        writeFileSync(join(folder, "big.bin"), "x".repeat(5_000_000));
        yield* Effect.flip(
          sendWorkFolder(id, folder, files, 1_000_000).pipe(
            Effect.provide(uploadLayers(env, "socket")),
            withRuntime(env),
          ),
        );
        // When
        const result = yield* Effect.promise(() =>
          runCli(env, ["upload", id, folder]),
        );
        // Then
        expect(result.stderr).toBe(
          "proofbox: uploading Work folder\nproofbox: sent 2 files, removed 0 files\n",
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive(
    "a grown Work file fails the upload with its own message without a Keeper",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox made with no Keeper; big.bin grew after the size
        // check
        const env = makeEnv();
        const error = yield* Effect.gen(function* () {
          yield* createSandbox({ os: "linux", provider: "fake" });
          const output = yield* CliOutput;
          const id = Chunk.toReadonlyArray(yield* Ref.get(output.captured.out))
            .join("")
            .trim();
          const { folder, files } = yield* grownFolder;
          // When
          return yield* Effect.flip(
            sendWorkFolder(id, folder, files, 1_000_000),
          );
        }).pipe(Effect.provide(uploadLayers(env, "direct")), withRuntime(env));
        // Then
        expect(error.message).toBe(grewMessage);
      }),
  );
});
