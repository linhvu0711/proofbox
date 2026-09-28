import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { listWorkFiles } from "../src/upload/work-files.ts";
import { cleanupEnvs, makeGitFolder } from "./support/cli.ts";

describe("work-files", () => {
  afterEach(cleanupEnvs);

  it.scopedLive("a regular file's size is the bytes hashed", () =>
    Effect.gen(function* () {
      // Given
      const folder = makeGitFolder({ committed: { "a.txt": "hello\n" } });
      // When
      const files = yield* listWorkFiles(folder);
      // Then
      expect(files.find((file) => file.path === "a.txt")).toEqual({
        path: "a.txt",
        size: 6,
        sha256:
          "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
        executable: false,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.scopedLive("a link's size is its lstat size", () =>
    Effect.gen(function* () {
      // Given: a new symlink link -> target.txt
      const folder = makeGitFolder({ committed: { "target.txt": "t\n" } });
      symlinkSync("target.txt", join(folder, "link"));
      // When
      const files = yield* listWorkFiles(folder);
      // Then
      expect(files.find((file) => file.path === "link")?.size).toBe(10);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
