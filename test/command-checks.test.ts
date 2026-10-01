import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Chunk, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  CHECKS_START,
  checksScript,
  checksTrailer,
  splitChecks,
} from "../src/command-checks.ts";
import { SandboxGoneError } from "../src/errors.ts";
import type { ExecEvent } from "../src/provider.ts";

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
const split = (...events: ReadonlyArray<ExecEvent>) =>
  splitChecks(
    Stream.fromIterable(events),
    () => new SandboxGoneError({ id: "docker:abc123" }),
  ).pipe(
    Stream.runCollect,
    Effect.map((collected) =>
      Chunk.toReadonlyArray(collected).map((event) =>
        event._tag === "Exit"
          ? event
          : { _tag: event._tag, text: new TextDecoder().decode(event.bytes) },
      ),
    ),
  );

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
        err(checksTrailer(2, 3)),
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
        err("box-checks 0 1\n"),
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
      expect(stderr).toBe(CHECKS_START + checksTrailer(4, 4));
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
        expect(run.stderr).toBe(`${CHECKS_START}err${checksTrailer(4, 4)}`);
        expect(run.status).toBe(3);
      }),
  );

  it.effect(
    "a failed Deadline write leaves stderr and the exit code alone",
    () =>
      Effect.sync(() => {
        // Given: the Deadline file's folder is not there
        // When
        const run = spawnSync(
          "sh",
          ["-c", script, "sh", "900", "900", "sh", "-c", "exit 5"],
          {
            env: { ...process.env, DL: "/nonexistent/proofbox/deadline" },
            encoding: "utf8",
          },
        );
        // Then
        expect(run.stderr).toBe(CHECKS_START + checksTrailer(4, 4));
        expect(run.status).toBe(5);
      }),
  );
});
