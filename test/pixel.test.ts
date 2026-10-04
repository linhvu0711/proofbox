import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { writeOut } from "../src/pixel.ts";

describe("Pixel output", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "proofbox-pixel-"));
    dirs.push(dir);
    return dir;
  };

  it.effect("writeOut saves the bytes at the path", () =>
    Effect.gen(function* () {
      // Given
      const path = join(tempDir(), "shot.png");
      // When
      yield* writeOut(path, new Uint8Array([1, 2, 3]));
      // Then
      expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("writeOut into a missing folder fails with OutFileError", () =>
    Effect.gen(function* () {
      // Given
      const path = join(tempDir(), "missing", "shot.png");
      // When
      const error = yield* Effect.flip(writeOut(path, new Uint8Array([1])));
      // Then
      expect(error._tag).toBe("OutFileError");
      expect(error.reason).toBe(
        `ENOENT: no such file or directory, open '${path}'`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
