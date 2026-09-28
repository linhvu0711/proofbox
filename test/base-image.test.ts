import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { baseImageVersion } from "../src/docker/base-image.ts";

describe("Base image", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.effect("baseImageVersion hashes the image files and the Tool bundle", () =>
    Effect.gen(function* () {
      // Given: an image dir, and the same dir with one file changed
      const dir = mkdtempSync(join(tmpdir(), "proofbox-image-"));
      dirs.push(dir);
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(dir, "init.sh"), "#!/bin/sh\n");
      // When
      const first = yield* baseImageVersion(dir, []);
      writeFileSync(join(dir, "Dockerfile"), "FROM debian\n");
      const second = yield* baseImageVersion(dir, []);
      // Then
      expect(first).toBe("8c858f0d6b7a");
      expect(second).toBe("dda6097aecf9");
    }),
  );
});
