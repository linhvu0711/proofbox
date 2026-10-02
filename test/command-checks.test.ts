import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Stream, TestClock } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  CHECKS_START,
  checksScript,
  endLine,
  pushFailedTrailer,
  splitChecks,
} from "../src/command-checks.ts";
import { ProviderError, SandboxGoneError } from "../src/errors.ts";
import type { ExecEvent } from "../src/provider.ts";
import { sleepsNear } from "./support/clock.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const bytes = (text: string) => new TextEncoder().encode(text);
const out = (text: string): ExecEvent => ({
  _tag: "Stdout",
  bytes: bytes(text),
});
const err = (text: string): ExecEvent => ({
  _tag: "Stderr",
  bytes: bytes(text),
});
const exit = (code: number): ExecEvent => ({ _tag: "Exit", code });

// The split events, with each chunk's bytes as text.
const splitStream = (events: Stream.Stream<ExecEvent>) =>
  splitChecks(events, {
    gone: () => new SandboxGoneError({ id: "docker:abc123" }),
    pushFailed: (detail) =>
      new ProviderError({
        provider: "docker",
        reason: `could not write the Deadline: ${detail}`,
      }),
  }).pipe(
    Stream.runCollect,
    Effect.map((collected) =>
      Chunk.toReadonlyArray(collected).map((event) =>
        event._tag === "Exit"
          ? event
          : { _tag: event._tag, text: new TextDecoder().decode(event.bytes) },
      ),
    ),
  );

const split = (...events: ReadonlyArray<ExecEvent>) =>
  splitStream(Stream.fromIterable(events));

const script = checksScript({
  push: 'printf %s "$d" > "$DL"',
  kills: "echo 4",
  run: '"$@"',
});

describe("command checks", () => {
  it.effect("the trailer is cut and its counts land on Exit", () =>
    Effect.gen(function* () {
      // Given / When
      const events = yield* split(
        err(CHECKS_START),
        out("out"),
        err("err"),
        err(endLine(0, 3, { before: 2, after: 3 })),
        exit(0),
      );
      // Then
      expect(events).toEqual([
        { _tag: "Stdout", text: "out" },
        { _tag: "Stderr", text: "err" },
        { _tag: "Exit", code: 0, kills: { before: 2, after: 3 } },
      ]);
    }),
  );

  it.effect("a trailer split over two chunks is still cut", () =>
    Effect.gen(function* () {
      // Given / When
      const events = yield* split(
        err(CHECKS_START),
        err("err\n\x1fproof"),
        err("box-checks 0 1 0 0\n"),
        exit(0),
      );
      // Then
      const stderr = events
        .flatMap((event) => ("text" in event ? [event.text] : []))
        .join("");
      expect(stderr).toBe("err");
      expect(events.at(-1)).toEqual({
        _tag: "Exit",
        code: 0,
        kills: { before: 0, after: 1 },
      });
    }),
  );

  it.effect(
    "Docker's no such container before the start mark is a gone Sandbox",
    () =>
      Effect.gen(function* () {
        // Given / When
        const error = yield* split(
          err(
            "Error response from daemon: No such container: proofbox-abc123\n",
          ),
          exit(1),
        ).pipe(Effect.flip);
        // Then
        expect(error).toBeInstanceOf(SandboxGoneError);
        expect(error.message).toBe("Sandbox docker:abc123 is gone");
      }),
  );

  it.effect("a runtime warning before the start mark reaches the Caller", () =>
    Effect.gen(function* () {
      // Given / When: the mark split over two chunks, after a warning
      const events = yield* split(
        err("Warning: remote host notice\n\x1fproof"),
        err("box-start\n"),
        out("done\n"),
        err(endLine(0, 5, { before: 0, after: 0 })),
        exit(0),
      );
      // Then
      expect(events).toEqual([
        { _tag: "Stderr", text: "Warning: remote host notice\n" },
        { _tag: "Stdout", text: "done\n" },
        { _tag: "Exit", code: 0, kills: { before: 0, after: 0 } },
      ]);
    }),
  );

  it.effect("other text before the start mark passes through", () =>
    Effect.gen(function* () {
      // Given / When
      const events = yield* split(
        err("OCI runtime exec failed: boom\n"),
        exit(126),
      );
      // Then
      expect(events).toEqual([
        { _tag: "Stderr", text: "OCI runtime exec failed: boom\n" },
        { _tag: "Exit", code: 126 },
      ]);
    }),
  );

  it.effect("the script caps the Deadline at Max life", () =>
    Effect.sync(() => {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      const deadlineFile = join(root, "deadline");
      const t0 = Math.floor(Date.now() / 1000);
      // When
      const stderr = spawnSync(
        "sh",
        ["-c", script, "sh", "900", "60", "true"],
        { env: { ...process.env, DL: deadlineFile }, encoding: "utf8" },
      ).stderr;
      // Then
      const pushed = Number(readFileSync(deadlineFile, "utf8")) - t0;
      expect([60, 61]).toContain(pushed);
      expect(stderr).toBe(
        CHECKS_START + endLine(0, 0, { before: 4, after: 4 }),
      );
    }),
  );

  it.effect(
    "the script passes the command's output and exit code through",
    () =>
      Effect.sync(() => {
        // Given
        const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
        tempRoots.push(root);
        // When
        const run = spawnSync(
          "sh",
          [
            "-c",
            script,
            "sh",
            "900",
            "900",
            "sh",
            "-c",
            "printf out; printf err >&2; exit 3",
          ],
          {
            env: { ...process.env, DL: join(root, "deadline") },
            encoding: "utf8",
          },
        );
        // Then
        expect(run.stdout).toBe("out");
        expect(run.stderr).toBe(
          `${CHECKS_START}err${endLine(3, 3, { before: 4, after: 4 })}`,
        );
        expect(run.status).toBe(3);
      }),
  );

  it.effect("a failed Deadline write before the command stops it", () =>
    Effect.sync(() => {
      // Given: the Deadline file's folder is not there
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      const ran = join(root, "ran");
      // When
      const run = spawnSync(
        "sh",
        ["-c", script, "sh", "900", "900", "touch", ran],
        {
          env: { ...process.env, DL: "/nonexistent/proofbox/deadline" },
          encoding: "utf8",
        },
      );
      // Then
      expect(run.stderr.startsWith(`${CHECKS_START}\n\x1fproofbox-fail `)).toBe(
        true,
      );
      expect(run.stderr).toContain("/nonexistent/proofbox/deadline");
      expect(run.stderr.endsWith("\n")).toBe(true);
      expect(existsSync(ran)).toBe(false);
      expect(run.status).toBe(1);
    }),
  );

  it.effect("a failed Deadline write after the command ends the run", () =>
    Effect.sync(() => {
      // Given: the first push writes, the second fails
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      const once = checksScript({
        push: 'if [ -e "$PUSHED" ]; then echo "disk full" >&2; false; else touch "$PUSHED"; fi',
        kills: "echo 4",
        run: '"$@"',
      });
      // When
      const run = spawnSync(
        "sh",
        ["-c", once, "sh", "900", "900", "printf", "out"],
        {
          env: { ...process.env, PUSHED: join(root, "pushed") },
          encoding: "utf8",
        },
      );
      // Then
      expect(run.stdout).toBe("out");
      expect(run.stderr).toBe(CHECKS_START + pushFailedTrailer("disk full"));
      expect(run.status).toBe(1);
    }),
  );

  it.effect("a fail trailer fails with the push's own error", () =>
    Effect.gen(function* () {
      // Given / When: the trailer split over two chunks
      const error = yield* split(
        err(CHECKS_START),
        err("\n\x1fproofbox-fail mv: cannot move: Read-only"),
        err(" file system \n"),
        exit(1),
      ).pipe(Effect.flip);
      // Then
      expect(error.message).toBe(
        "Provider docker failed: could not write the Deadline: mv: cannot move: Read-only file system",
      );
    }),
  );
  it.effect("the exit code comes from the End line", () =>
    Effect.gen(function* () {
      // Given / When: the link exits 0, the command exited 3
      const events = yield* split(
        err(CHECKS_START),
        out("out"),
        err(endLine(3, 3, { before: 2, after: 3 })),
        exit(0),
      );
      // Then
      expect(events).toEqual([
        { _tag: "Stdout", text: "out" },
        { _tag: "Exit", code: 3, kills: { before: 2, after: 3 } },
      ]);
    }),
  );

  it.effect("the End line counts every byte of a 3.5 MB output", () =>
    Effect.sync(() => {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      // When
      const run = spawnSync(
        "sh",
        [
          "-c",
          script,
          "sh",
          "900",
          "900",
          "head",
          "-c",
          "3670016",
          "/dev/zero",
        ],
        {
          env: { ...process.env, DL: join(root, "deadline") },
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      // Then
      expect({
        stdout: run.stdout.length,
        stderr: run.stderr,
        status: run.status,
      }).toEqual({
        stdout: 3670016,
        stderr: CHECKS_START + endLine(0, 3670016, { before: 4, after: 4 }),
        status: 0,
      });
    }),
  );

  it.effect("the End line counts one byte as 1", () =>
    Effect.sync(() => {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      // When
      const run = spawnSync(
        "sh",
        ["-c", script, "sh", "900", "900", "printf", "x"],
        {
          env: { ...process.env, DL: join(root, "deadline") },
          encoding: "utf8",
        },
      );
      // Then
      expect(run.stderr).toBe(
        CHECKS_START + endLine(0, 1, { before: 4, after: 4 }),
      );
    }),
  );

  it.effect(
    "the End line waits for a background writer that holds stdout",
    () =>
      Effect.sync(() => {
        // Given
        const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
        tempRoots.push(root);
        // When
        const run = spawnSync(
          "sh",
          [
            "-c",
            script,
            "sh",
            "900",
            "900",
            "sh",
            "-c",
            "printf abc; (sleep 2; printf def) &",
          ],
          {
            env: { ...process.env, DL: join(root, "deadline") },
            encoding: "utf8",
          },
        );
        // Then
        expect({ stdout: run.stdout, stderr: run.stderr }).toEqual({
          stdout: "abcdef",
          stderr: CHECKS_START + endLine(0, 6, { before: 4, after: 4 }),
        });
      }),
  );

  it.effect("a background process off stdout does not hold the End line", () =>
    Effect.sync(() => {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
      tempRoots.push(root);
      const start = Date.now();
      // When
      const run = spawnSync(
        "sh",
        [
          "-c",
          script,
          "sh",
          "900",
          "900",
          "sh",
          "-c",
          "printf abc; nohup sleep 5 >/dev/null 2>&1 &",
        ],
        {
          env: { ...process.env, DL: join(root, "deadline") },
          encoding: "utf8",
        },
      );
      // Then
      expect({
        fast: Date.now() - start < 2000,
        stderr: run.stderr,
      }).toEqual({
        fast: true,
        stderr: CHECKS_START + endLine(0, 3, { before: 4, after: 4 }),
      });
    }),
  );
  it.effect(
    "a command ends 1 s after its End line when the link stays open",
    () =>
      Effect.gen(function* () {
        // Given: the link never closes
        const events = Stream.concat(
          Stream.fromIterable([
            err(CHECKS_START),
            out("abc"),
            err(endLine(0, 3, { before: 0, after: 0 })),
          ]),
          Stream.never,
        );
        // When
        const fiber = yield* Effect.fork(splitStream(events));
        yield* sleepsNear(1_000);
        yield* TestClock.adjust("1 second");
        const split = yield* Fiber.join(fiber);
        // Then
        expect(split).toEqual([
          { _tag: "Stdout", text: "abc" },
          {
            _tag: "Exit",
            code: 0,
            kills: { before: 0, after: 0 },
            stillOpen: true,
          },
        ]);
      }),
  );

  it.effect(
    "output that comes 2 s after the End line still ends the call",
    () =>
      Effect.gen(function* () {
        // Given: the output comes 2 s late, and the link never closes
        const events = Stream.concat(
          Stream.fromIterable([
            err(CHECKS_START),
            err(endLine(0, 3, { before: 0, after: 0 })),
          ]),
          Stream.concat(
            Stream.fromEffect(Effect.as(Effect.sleep("2 seconds"), out("abc"))),
            Stream.never,
          ),
        );
        // When
        const fiber = yield* Effect.fork(splitStream(events));
        yield* sleepsNear(1_000, 2_000);
        yield* TestClock.adjust("2 seconds");
        const split = yield* Fiber.join(fiber);
        // Then
        expect(split).toEqual([
          { _tag: "Stdout", text: "abc" },
          {
            _tag: "Exit",
            code: 0,
            kills: { before: 0, after: 0 },
            stillOpen: true,
          },
        ]);
      }),
  );

  it.effect("a command quiet for 600 s is not cut", () =>
    Effect.gen(function* () {
      // Given: 600 s with no output, then the End line and the exit
      const events = Stream.concat(
        Stream.fromIterable([err(CHECKS_START)]),
        Stream.concat(
          Stream.fromEffect(Effect.sleep("600 seconds")).pipe(Stream.drain),
          Stream.fromIterable([
            err(endLine(0, 0, { before: 0, after: 0 })),
            exit(0),
          ]),
        ),
      );
      // When
      const fiber = yield* Effect.fork(splitStream(events));
      yield* sleepsNear(600_000);
      yield* TestClock.adjust("600 seconds");
      const split = yield* Fiber.join(fiber);
      // Then
      expect(split).toEqual([
        { _tag: "Exit", code: 0, kills: { before: 0, after: 0 } },
      ]);
    }),
  );

  it.effect(
    "a fail line ends the call without waiting for the link to close",
    () =>
      Effect.gen(function* () {
        // Given: the link never closes
        const events = Stream.concat(
          Stream.fromIterable([
            err(CHECKS_START),
            err(pushFailedTrailer("disk full")),
          ]),
          Stream.never,
        );
        // When
        const error = yield* splitStream(events).pipe(Effect.flip);
        // Then
        expect(error.message).toBe(
          "Provider docker failed: could not write the Deadline: disk full",
        );
      }),
  );
});
