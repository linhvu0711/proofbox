import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  type KeeperLogEntry,
  keeperLogLine,
  programOf,
  writeKeeperLog,
} from "../src/keeper/keeper-log.ts";

const dirs: string[] = [];

const tempLog = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-log-"));
  dirs.push(dir);
  return join(dir, "fake-abc123.log");
};

const entry: KeeperLogEntry = {
  at: new Date("2026-10-01T08:28:54.960Z"),
  kind: "exec",
  program: programOf(["/opt/proofbox/pixel", "screenshot"]),
  out: 5603328,
  err: 22,
  exit: undefined,
  firstMs: 118400,
  tookMs: 120000,
  ended: "gave up",
};

describe("Keeper log", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.effect("a log line holds the program, bytes, exit, times, and end", () =>
    Effect.gen(function* () {
      // Given
      const path = tempLog();
      // When
      yield* writeKeeperLog(path, entry);
      // Then
      expect(readFileSync(path, "utf8")).toBe(
        "2026-10-01T08:28:54Z exec pixel screenshot out=5603328 err=22 exit=- first=118.4s took=120.0s gave up\n",
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("a command that wrote no output shows no first-byte time", () => {
    // Given
    const silent: KeeperLogEntry = {
      ...entry,
      program: programOf(["/opt/proofbox/pixel", "key"]),
      out: 0,
      err: 0,
      exit: 0,
      firstMs: undefined,
      tookMs: 1500,
      ended: "done",
    };
    // When
    const line = keeperLogLine(silent);
    // Then
    expect(line).toBe(
      "2026-10-01T08:28:54Z exec pixel key out=0 err=0 exit=0 first=- took=1.5s done\n",
    );
  });

  it("a pixel line names the sub-command and not the text", () => {
    // Given
    const argv = [
      "/opt/proofbox/pixel",
      "type",
      "80",
      "700",
      "0",
      "s3cret-text",
    ];
    // When
    const program = programOf(argv);
    // Then
    expect(program).toBe("pixel type");
  });

  it.effect("the log file is mode 600", () =>
    Effect.gen(function* () {
      // Given: no log yet
      const path = tempLog();
      // When
      yield* writeKeeperLog(path, entry);
      // Then
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a log past 1 MB moves to .log.1 and a new one starts", () =>
    Effect.gen(function* () {
      // Given: a full log
      const path = tempLog();
      writeFileSync(path, "x".repeat(1_048_576));
      // When
      yield* writeKeeperLog(path, entry);
      // Then
      expect({
        old: statSync(`${path}.1`).size,
        lines: readFileSync(path, "utf8").split("\n").length - 1,
      }).toEqual({ old: 1_048_576, lines: 1 });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("two writes at a full log keep both lines and the old file", () =>
    Effect.gen(function* () {
      // Given: a full log
      const path = tempLog();
      writeFileSync(path, "x".repeat(1_048_576));
      // When: two requests end together
      yield* Effect.all(
        [writeKeeperLog(path, entry), writeKeeperLog(path, entry)],
        {
          concurrency: "unbounded",
        },
      );
      // Then
      expect({
        old: statSync(`${path}.1`).size,
        lines: readFileSync(path, "utf8").split("\n").length - 1,
      }).toEqual({ old: 1_048_576, lines: 2 });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
