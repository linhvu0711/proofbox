import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import { withFileLock } from "../src/file-lock.ts";
import { trackTempDir } from "./support/cli.ts";

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-lock-"));
  trackTempDir(dir);
  return dir;
};

describe("file-lock", () => {
  it.effect("a lock is released when the locked effect fails", () =>
    Effect.gen(function* () {
      // Given
      const lock = join(tempDir(), "x.lock");
      const options = {
        dir: lock,
        wait: "1 second",
        busy: () => "busy",
        failed: () => "failed",
      } as const;
      // When
      const error = yield* withFileLock(options)(Effect.fail("boom")).pipe(
        Effect.flip,
      );
      // Then
      expect(error).toBe("boom");
      expect(existsSync(lock)).toBe(false);
    }),
  );

  it.effect("a lock is released when the locked effect is interrupted", () =>
    Effect.gen(function* () {
      // Given
      const lock = join(tempDir(), "x.lock");
      const options = {
        dir: lock,
        wait: "1 second",
        busy: () => "busy",
        failed: () => "failed",
      } as const;
      const started = yield* Deferred.make<void>();
      // When
      const fiber = yield* Effect.fork(
        withFileLock(options)(
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        ),
      );
      yield* Deferred.await(started);
      const held = existsSync(lock);
      yield* Fiber.interrupt(fiber);
      // Then
      expect(held).toBe(true);
      expect(existsSync(lock)).toBe(false);
    }),
  );

  it.live("a held lock fails with the busy error after the wait", () =>
    Effect.gen(function* () {
      // Given
      const lock = join(tempDir(), "x.lock");
      mkdirSync(lock);
      const options = {
        dir: lock,
        wait: "300 millis",
        busy: () => "busy",
        failed: () => "failed",
      } as const;
      // When
      const error = yield* withFileLock(options)(Effect.succeed(1)).pipe(
        Effect.flip,
      );
      // Then
      expect(error).toBe("busy");
      expect(existsSync(lock)).toBe(true);
    }),
  );

  it.live("a busy lock inside a traced function waits for the holder", () =>
    Effect.gen(function* () {
      // Given: the lock is held, and the holder lets go after 300 ms
      const lock = join(tempDir(), "x.lock");
      mkdirSync(lock);
      const options = {
        dir: lock,
        wait: "5 seconds",
        busy: () => new Error("busy"),
        failed: () => new Error("failed"),
      } as const;
      yield* Effect.fork(
        Effect.sleep("300 millis").pipe(
          Effect.zipRight(Effect.sync(() => rmSync(lock, { recursive: true }))),
        ),
      );
      const locked = Effect.fn("test.locked")(function* () {
        return yield* withFileLock(options)(Effect.succeed("ran"));
      });
      // When
      const result = yield* locked();
      // Then
      expect(result).toBe("ran");
      expect(existsSync(lock)).toBe(false);
    }),
  );
});
