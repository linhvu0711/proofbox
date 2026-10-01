import { Effect, Stream } from "effect";
import type { SandboxGoneError } from "./errors.ts";
import type { ExecEvent, SandboxInfo } from "./provider.ts";

// One remote call runs a command with its checks around it (ADR 0015): the
// Deadline pushed by the idle time before and after it, and the
// memory-kill count read just before and just after it. The script marks
// the start of its own stderr and ends it with a trailer that holds the
// two counts; `splitChecks` takes both out again.

export const CHECKS_START = "\x1fproofbox-start\n";

export const checksTrailer = (before: number, after: number) =>
  `\n\x1fproofbox-checks ${before} ${after}\n`;

// The shell for one Provider's checks. `push` writes the Deadline in `$d`
// (epoch seconds), `kills` prints the kill count, and `run` runs `"$@"` as
// the Sandbox user.
export interface ChecksShell {
  readonly push: string;
  readonly kills: string;
  readonly run: string;
}

// Runs as `sh -c <script> sh <idleSeconds> <leftSeconds> <argv...>`. The
// Deadline is set on the Sandbox's own clock, as `extend` does. A failed
// push or count does not stop the command, and says nothing on stderr.
export const checksScript = (shell: ChecksShell) =>
  [
    "idle=$1",
    "cap=$(( $(date +%s) + $2 ))",
    "shift 2",
    `push() { d=$(( $(date +%s) + idle )); [ "$d" -gt "$cap" ] && d=$cap; { ${shell.push}; } 2>/dev/null; }`,
    "printf '\\037proofbox-start\\n' >&2",
    "push",
    `k1=$( { ${shell.kills}; } 2>/dev/null)`,
    shell.run,
    "code=$?",
    `k2=$( { ${shell.kills}; } 2>/dev/null)`,
    "push",
    `printf '\\n\\037proofbox-checks %s %s\\n' "\${k1:-0}" "\${k2:-0}" >&2`,
    "exit $code",
  ].join("; ");

export const checksArgv = (
  script: string,
  info: SandboxInfo,
  nowMillis: number,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const left = Math.max(
    0,
    Math.floor((info.maxLifeAt.getTime() - nowMillis) / 1000),
  );
  return [
    "sh",
    "-c",
    script,
    "sh",
    String(info.idleSeconds),
    String(left),
    ...argv,
  ];
};

// What Docker prints when the container is not there, as `getWith` reads it.
const GONE = /no such container|no such object|is not running/i;
const TRAILER_HEAD = "\n\x1fproofbox-checks ";
// Longer than any trailer, so a tail past this can never start one.
const TRAILER_MAX = TRAILER_HEAD.length + 2 * 20 + 2;

// True when `text` is a trailer or the first part of one.
const couldStartTrailer = (text: string) =>
  text.length <= TRAILER_HEAD.length
    ? TRAILER_HEAD.startsWith(text)
    : text.startsWith(TRAILER_HEAD) &&
      /^(\d*|\d+ \d*|\d+ \d+\n)$/.test(text.slice(TRAILER_HEAD.length));

// Where in `bytes` a held tail starts: the first place from which the rest
// could be the trailer, or the end.
const tailStart = (bytes: Buffer) => {
  // latin1 keeps one char per byte, so string and byte offsets agree.
  const text = bytes.toString("latin1");
  for (
    let at = Math.max(0, text.length - TRAILER_MAX);
    at < text.length;
    at++
  ) {
    if (text[at] === "\n" && couldStartTrailer(text.slice(at))) {
      return at;
    }
  }
  return text.length;
};

const stderr = (bytes: Uint8Array): ExecEvent => ({ _tag: "Stderr", bytes });

// Turns the events of a `checksScript` call into the Caller's: the start
// mark and the trailer go, and the two counts land on the Exit event.
// Stderr before the start mark is the runtime's own (the script never
// started): a gone container there fails with `gone()`, and any other text
// goes out as it is. After the mark, only a stderr tail that could start
// the trailer is held back, until the next chunk or the Exit.
export const splitChecks = <E>(
  events: Stream.Stream<ExecEvent, E>,
  gone: () => SandboxGoneError,
): Stream.Stream<ExecEvent, E | SandboxGoneError> =>
  Stream.suspend(() => {
    let started = false;
    let held = Buffer.alloc(0);
    const step = (
      event: ExecEvent,
    ): Effect.Effect<ReadonlyArray<ExecEvent>, SandboxGoneError> => {
      switch (event._tag) {
        case "Stdout":
          return Effect.succeed([event]);
        case "Stderr": {
          held = Buffer.concat([held, event.bytes]);
          if (!started) {
            const mark = held.indexOf(CHECKS_START, 0, "latin1");
            if (mark === -1) {
              return Effect.succeed([]);
            }
            started = true;
            held = held.subarray(mark + CHECKS_START.length);
          }
          const at = tailStart(held);
          const out = held.subarray(0, at);
          held = held.subarray(at);
          return Effect.succeed(out.length === 0 ? [] : [stderr(out)]);
        }
        case "Exit": {
          const rest = held;
          held = Buffer.alloc(0);
          if (!started) {
            if (GONE.test(rest.toString("utf8"))) {
              return Effect.fail(gone());
            }
            return Effect.succeed(
              rest.length === 0 ? [event] : [stderr(rest), event],
            );
          }
          const text = rest.toString("latin1");
          const trailer = text.startsWith(TRAILER_HEAD)
            ? /^(\d+) (\d+)\n$/.exec(text.slice(TRAILER_HEAD.length))
            : null;
          if (trailer === null) {
            return Effect.succeed(
              rest.length === 0 ? [event] : [stderr(rest), event],
            );
          }
          return Effect.succeed([
            {
              ...event,
              kills: { before: Number(trailer[1]), after: Number(trailer[2]) },
            },
          ]);
        }
      }
    };
    return events.pipe(Stream.mapEffect(step), Stream.flattenIterables);
  });
