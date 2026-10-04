import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
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
    }).pipe(Effect.provide(NodeContext.layer)),
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
    }).pipe(Effect.provide(NodeContext.layer)),
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
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("two takers of one free lock hold it one at a time", () =>
    Effect.gen(function* () {
      // Given: a free lock, and work that counts who is inside at once
      const lock = join(tempDir(), "x.lock");
      const options = {
        dir: lock,
        wait: "5 seconds",
        busy: () => "busy",
        failed: () => "failed",
      } as const;
      let inside = 0;
      let most = 0;
      let ran = 0;
      const work = Effect.sync(() => {
        inside += 1;
        most = Math.max(most, inside);
      }).pipe(
        Effect.zipRight(Effect.sleep("50 millis")),
        Effect.zipRight(
          Effect.sync(() => {
            inside -= 1;
            ran += 1;
          }),
        ),
      );
      // When: both take the lock at once
      yield* Effect.all(
        [withFileLock(options)(work), withFileLock(options)(work)],
        { concurrency: "unbounded" },
      );
      // Then
      expect({ most, ran, held: existsSync(lock) }).toEqual({
        most: 1,
        ran: 2,
        held: false,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
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
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
