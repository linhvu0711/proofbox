import { Deferred, Duration, Effect, Stream } from "effect";
import type { ProviderError, SandboxGoneError } from "./errors.ts";
import type { ExecEvent, MemoryKills, SandboxInfo } from "./provider.ts";

// One remote call runs a command with its checks around it (ADR 0015): the
// Deadline pushed by the idle time before and after it, and the
// memory-kill count read just before and just after it. The script marks
// the start of its own stderr and ends it with the End line (ADR 0021):
// the two counts, the command's exit code, and how many bytes of stdout
// it made; `splitChecks` takes both out again.

export const CHECKS_START = "\x1fproofbox-start\n";

export const endLine = (code: number, bytes: number, kills: MemoryKills) =>
  `\n\x1fproofbox-checks ${kills.before} ${kills.after} ${code} ${bytes}\n`;

// The shell for one Provider's checks. `push` writes the Deadline in `$d`
// (epoch seconds), `kills` prints the kill count, and `run` runs `"$@"` as
// the Sandbox user.
export interface ChecksShell {
  readonly push: string;
  readonly kills: string;
  readonly run: string;
}

export const pushFailedTrailer = (detail: string) =>
  `\n\x1fproofbox-fail ${detail}\n`;

// The most of a failed push's own error the fail trailer carries.
const FAIL_DETAIL_MAX = 200;

// How long a command whose End line and stdout are all in waits for the
// link to close, so the Keeper log can tell a link that did not close
// (ADR 0021).
const CLOSE_WAIT = Duration.seconds(1);
// How long after the End line stdout may still be short before the call
// fails.
const LATE_OUTPUT = Duration.seconds(5);

// Why a call fails when stdout that the End line counted never came.
const lostReason = (code: number, missing: number) =>
  `lost ${missing} bytes of the command's output on the way. The command did run and exited ${code}, so running it again runs it twice.`;

// Runs as `sh -c <script> sh <idleSeconds> <leftSeconds> <argv...>`. The
// Deadline is set on the Sandbox's own clock, as `extend` does. A failed
// push ends the script with the fail trailer in place of the End line, as
// a failed push ended `exec` before the Keeper did it: before the command,
// the command does not run. A failed count reads as 0. The command's
// stdout goes through `dd`, which counts it once every writer of it is
// done; the command runs in a subshell with fds 5 and 6 closed, so a
// background process it leaves does not hold the count open.
export const checksScript = (shell: ChecksShell) =>
  [
    "idle=$1",
    "cap=$(( $(date +%s) + $2 ))",
    "shift 2",
    `push() { d=$(( $(date +%s) + idle )); [ "$d" -gt "$cap" ] && d=$cap; pe=$( { ${shell.push}; } 2>&1 ); }`,
    `pushfail() { printf '\\n\\037proofbox-fail %s\\n' "$(printf %s "$pe" | tr '\\n' ' ' | cut -c1-${FAIL_DETAIL_MAX})" >&2; exit 1; }`,
    "printf '\\037proofbox-start\\n' >&2",
    "push || pushfail",
    `k1=$( { ${shell.kills}; } 2>/dev/null)`,
    "exec 5>&1",
    `r=$( { { ( ${shell.run} ) 5>&- 6>&-; echo "c $?" >&6; } | LC_ALL=C dd bs=65536 2>&1 >&5 5>&-; } 6>&1 )`,
    `code=$(printf '%s\\n' "$r" | sed -n 's/^c //p')`,
    `n=$(printf '%s\\n' "$r" | sed -n 's/^\\([0-9][0-9]*\\) byte.*/\\1/p')`,
    `k2=$( { ${shell.kills}; } 2>/dev/null)`,
    "push || pushfail",
    `printf '\\n\\037proofbox-checks %s %s %s %s\\n' "\${k1:-0}" "\${k2:-0}" "$code" "$n" >&2`,
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
const FAIL_HEAD = "\n\x1fproofbox-fail ";
// Longer than any trailer, so a tail past this can never start one.
const TRAILER_MAX = FAIL_HEAD.length + FAIL_DETAIL_MAX + 1;

// True when `text` is `head` and then text that `rest` accepts, or the
// first part of that.
const couldStart = (text: string, head: string, rest: RegExp) =>
  text.length <= head.length
    ? head.startsWith(text)
    : text.startsWith(head) && rest.test(text.slice(head.length));

// True when `text` is a trailer or the first part of one.
const couldStartTrailer = (text: string) =>
  couldStart(text, TRAILER_HEAD, /^((\d+ ){0,3}\d*|(\d+ ){3}\d+\n)$/) ||
  couldStart(text, FAIL_HEAD, /^[^\n]*\n?$/);

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

// The End line in `text`, when `text` is one whole End line.
const endLineOf = (text: string) => {
  const fields = text.startsWith(TRAILER_HEAD)
    ? /^(\d+) (\d+) (\d+) (\d+)\n$/.exec(text.slice(TRAILER_HEAD.length))
    : null;
  return fields === null
    ? undefined
    : {
        code: Number(fields[3]),
        bytes: Number(fields[4]),
        kills: { before: Number(fields[1]), after: Number(fields[2]) },
      };
};

// The wait that starts at the End line ticks once it is over.
type Tick = { readonly _tag: "CloseWait" } | { readonly _tag: "Late" };

// Turns the events of a `checksScript` call into the Caller's: the start
// mark and the End line go, and the End line's exit code and counts land
// on the Exit event. A fail trailer fails with `pushFailed()` and the
// push's own error. Stderr before the start mark is the runtime's own:
// with no mark (the script never started), a gone container there fails
// with `gone()`; any other text goes out as it is. After the mark, only a
// stderr tail that could start the End line is held back, until the next
// chunk or the Exit. The command ends at its End line, not at the link's
// exit (ADR 0021): once all the stdout it counts is in, it waits at most
// `CLOSE_WAIT` for the link to close, then ends with `stillOpen`. Stdout
// still short 5 s after the End line, or when the link closes, fails
// with `lost()`.
export const splitChecks = <E>(
  events: Stream.Stream<ExecEvent, E>,
  on: {
    readonly gone: () => SandboxGoneError;
    readonly pushFailed: (detail: string) => ProviderError;
    readonly lost: (reason: string) => ProviderError;
  },
): Stream.Stream<ExecEvent, E | SandboxGoneError | ProviderError> =>
  Stream.unwrap(
    Effect.map(Deferred.make<void>(), (endSeen) => {
      let started = false;
      let held = Buffer.alloc(0);
      // The stdout bytes so far, and the End line once it is in.
      let seen = 0;
      let end: ReturnType<typeof endLineOf>;
      let closeWaitOver = false;
      const endedOpen = (): ReadonlyArray<ExecEvent> =>
        end !== undefined && closeWaitOver && seen >= end.bytes
          ? [
              {
                _tag: "Exit",
                code: end.code,
                kills: end.kills,
                stillOpen: true,
              },
            ]
          : [];
      const step = (
        event: ExecEvent | Tick,
      ): Effect.Effect<
        ReadonlyArray<ExecEvent>,
        SandboxGoneError | ProviderError
      > => {
        switch (event._tag) {
          case "Stdout":
            seen += event.bytes.length;
            return Effect.succeed([event, ...endedOpen()]);
          case "Stderr": {
            held = Buffer.concat([held, event.bytes]);
            // The runtime's own stderr before the mark (an ssh or Docker
            // warning) goes out as it is.
            let before = Buffer.alloc(0);
            if (!started) {
              const mark = held.indexOf(CHECKS_START, 0, "latin1");
              if (mark === -1) {
                return Effect.succeed([]);
              }
              started = true;
              before = held.subarray(0, mark);
              held = held.subarray(mark + CHECKS_START.length);
            }
            const at = tailStart(held);
            const out = Buffer.concat([before, held.subarray(0, at)]);
            held = held.subarray(at);
            const passed = out.length === 0 ? [] : [stderr(out)];
            const text = held.toString("latin1");
            if (text.startsWith(FAIL_HEAD) && text.endsWith("\n")) {
              const detail = held
                .subarray(FAIL_HEAD.length, held.length - 1)
                .toString("utf8")
                .trim();
              return Effect.fail(on.pushFailed(detail || "the write failed"));
            }
            const line = endLineOf(text);
            if (line === undefined) {
              return Effect.succeed(passed);
            }
            end = line;
            held = Buffer.alloc(0);
            return Effect.as(Deferred.succeed(endSeen, undefined), passed);
          }
          case "CloseWait":
            closeWaitOver = true;
            return Effect.succeed(endedOpen());
          case "Late":
            return end !== undefined && seen < end.bytes
              ? Effect.fail(on.lost(lostReason(end.code, end.bytes - seen)))
              : Effect.succeed([]);
          case "Exit": {
            if (end !== undefined && seen < end.bytes) {
              return Effect.fail(
                on.lost(lostReason(end.code, end.bytes - seen)),
              );
            }
            if (end !== undefined) {
              return Effect.succeed([
                { _tag: "Exit", code: end.code, kills: end.kills },
              ]);
            }
            const rest = held;
            held = Buffer.alloc(0);
            if (!started && GONE.test(rest.toString("utf8"))) {
              return Effect.fail(on.gone());
            }
            return Effect.succeed(
              rest.length === 0 ? [event] : [stderr(rest), event],
            );
          }
        }
      };
      const ticks = Stream.fromEffect(Deferred.await(endSeen)).pipe(
        Stream.flatMap(() =>
          Stream.concat(
            Stream.fromEffect(
              Effect.as(Effect.sleep(CLOSE_WAIT), {
                _tag: "CloseWait",
              } as const),
            ),
            Stream.fromEffect(
              Effect.as(
                Effect.sleep(Duration.subtract(LATE_OUTPUT, CLOSE_WAIT)),
                { _tag: "Late" } as const,
              ),
            ),
          ),
        ),
      );
      return Stream.merge(events, ticks, { haltStrategy: "left" }).pipe(
        Stream.mapEffect(step),
        Stream.flattenIterables,
        Stream.takeUntil((event) => event._tag === "Exit"),
      );
    }),
  );
