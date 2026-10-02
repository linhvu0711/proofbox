import { appendFile, rename, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Effect } from "effect";
import { formatTime } from "../format-time.ts";

// The Keeper log (ADR 0019): one line per request, on the Caller's
// machine. It names only the program, never the arguments, the input, or
// the output, so a Secret in a command never lands in the file.

export type KeeperLogEntry = {
  readonly at: Date;
  readonly kind: "exec" | "info";
  // "-" for an info request.
  readonly program: string;
  readonly out: number;
  readonly err: number;
  readonly exit: number | undefined;
  readonly tookMs: number;
  // "done", "gave up", "Caller left", "gone", or "error: <kind>", as
  // "error: ProviderError". Never an error's text: it can hold the
  // command line.
  readonly ended: string;
};

// A log past this size moves to `.log.1`, so the folder holds at most two.
const ROTATE_AT = 1_048_576;

export const keeperLogLine = (entry: KeeperLogEntry) =>
  `${formatTime(entry.at)} ${entry.kind} ${entry.program} out=${entry.out} err=${entry.err} exit=${entry.exit ?? "-"} took=${(entry.tookMs / 1000).toFixed(1)}s ${entry.ended}\n`;

// proofbox's own helpers also name their sub-command ("pixel type"); its
// later arguments can hold typed text, so nothing past it is kept.
export const programOf = (argv: ReadonlyArray<string>) => {
  const [program = "-", sub] = argv;
  return program.startsWith("/opt/proofbox/")
    ? `${basename(program)} ${sub ?? ""}`.trim()
    : basename(program);
};

// One write at a time per log, so two requests that end together never
// both rotate it: the second rename would move the first's new file over
// the old one.
const writers = new Map<string, Effect.Semaphore>();
const writerOf = (path: string) => {
  const known = writers.get(path);
  if (known !== undefined) {
    return known;
  }
  const made = Effect.unsafeMakeSemaphore(1);
  writers.set(path, made);
  return made;
};

// A log that cannot be written never fails the command it describes, and
// a rotation that fails still lets the line be written.
export const writeKeeperLog = Effect.fn("keeperLog.write")(function* (
  path: string,
  entry: KeeperLogEntry,
) {
  yield* writerOf(path).withPermits(1)(
    Effect.gen(function* () {
      const size = yield* Effect.promise(() =>
        stat(path).then(
          (info) => info.size,
          () => 0,
        ),
      );
      if (size >= ROTATE_AT) {
        yield* Effect.ignore(
          Effect.tryPromise(() => rename(path, `${path}.1`)),
        );
      }
      yield* Effect.tryPromise(() =>
        appendFile(path, keeperLogLine(entry), { mode: 0o600 }),
      );
    }),
  );
}, Effect.ignore);
