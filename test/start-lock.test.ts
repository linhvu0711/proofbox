import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { withStartLock } from "../src/keeper/start-lock.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";

describe("start-lock", () => {
  afterEach(cleanupEnvs);

  it.live(
    "a start lock that cannot be written gives the write error, not a busy Keeper",
    () => {
      // Given: a live start lock in a dir that is read-only
      const dir = mkdtempSync(join(tmpdir(), "proofbox-start-lock-"));
      trackTempDir(dir);
      const lock = join(dir, "fake-x.start-lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), `${process.pid}\nlive\n\n`);
      chmodSync(dir, 0o500);
      return Effect.gen(function* () {
        // When
        const error = yield* withStartLock(lock, "fake", Effect.void).pipe(
          Effect.flip,
        );
        // Then
        expect(error.reason).toMatch(/permission denied/);
      }).pipe(
        Effect.ensuring(Effect.sync(() => chmodSync(dir, 0o700))),
        Effect.provide(NodeContext.layer),
      );
    },
  );
});
