import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import { readWorkFolder } from "../src/commands/upload.ts";
import { packFiles } from "../src/upload/pack.ts";
import { cleanupEnvs, makeGitFolder } from "./support/cli.ts";

// A folder whose big.bin passed a 1 MB check at 500 kB, then grew to 5 MB
// before tar read it.
const grownFolder = Effect.gen(function* () {
  const folder = makeGitFolder({
    committed: { "big.bin": "x".repeat(500_000) },
  });
  const files = yield* readWorkFolder(folder, 1_000_000);
  writeFileSync(join(folder, "big.bin"), "x".repeat(5_000_000));
  return { folder, paths: files.map((file) => file.path) };
});

describe("pack", () => {
  afterEach(cleanupEnvs);

  it.scopedLive(
    "a Work file that grew past the limit stops the tar stream",
    () =>
      Effect.gen(function* () {
        // Given
        const { folder, paths } = yield* grownFolder;
        // When
        const error = yield* Effect.flip(
          Stream.runDrain(packFiles(folder, "fake:x", paths, 1_000_000)),
        );
        // Then
        expect(error.message).toBe(
          "A Work file grew while uploading, so the upload stopped past the 1.0 MB limit. Run it again, or raise the limit with --max-size.",
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive("a stopped tar stream leaves no tar process", () =>
    Effect.gen(function* () {
      // Given
      const { folder, paths } = yield* grownFolder;
      // When
      yield* Effect.flip(
        Stream.runDrain(packFiles(folder, "fake:x", paths, 1_000_000)),
      );
      // Then
      const found = spawnSync("pgrep", [
        "-P",
        String(process.pid),
        "-x",
        "tar",
      ]);
      expect(found.status).toBe(1);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive("many small files just under the limit pack in full", () =>
    Effect.gen(function* () {
      // Given: 1000 files of 999 bytes (999,000 bytes), one of them under a
      // path long enough to need a long-name header
      const long = `${"d".repeat(70)}/${"f".repeat(79)}`;
      const committed: Record<string, string> = {
        [long]: "x".repeat(999),
      };
      for (let i = 1; i < 1000; i += 1) {
        committed[`f${String(i).padStart(4, "0")}.txt`] = "x".repeat(999);
      }
      const folder = makeGitFolder({ committed });
      const files = yield* readWorkFolder(folder, 1_000_000);
      // When
      const exit = yield* Effect.exit(
        Stream.runDrain(
          packFiles(
            folder,
            "fake:x",
            files.map((file) => file.path),
            1_000_000,
          ),
        ),
      );
      // Then
      expect(exit._tag).toBe("Success");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
