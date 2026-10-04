import { Clock, Duration, Effect, Fiber, Stream } from "effect";
import { pushedDeadline } from "./deadline.ts";
import type {
  ProviderError,
  ProviderUnavailableError,
  SandboxGoneError,
} from "./errors.ts";
import type {
  Connection,
  ExecEvent,
  ExecOptions,
  SandboxCallError,
  SandboxInfo,
} from "./provider.ts";

// The command run: each command runs with its checks around it, in one
// remote call (ADR 0015): the Deadline pushed by the idle time before and
// after it, and the memory-kill count read just before and just after it.
// The script marks the start of its own stderr and ends it with a trailer
// that holds the two counts; `splitChecks` takes both out again. A long
// command also gets the Deadline pushed while it runs.

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

// What a Provider gives the command run: how one argv reaches the Sandbox,
// the shell its checks are written in, and its own errors.
export interface Transport {
  readonly shell: ChecksShell;
  readonly call: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Stream.Stream<
    ExecEvent,
    ProviderError | ProviderUnavailableError | SandboxGoneError
  >;
  readonly gone: () => SandboxGoneError;
  readonly fail: (reason: string) => ProviderError;
  // The host side of each Deadline push, for a Provider whose Sandbox lives
  // on a host with a life of its own. The command run gives it the pushed
  // Deadline before the command and at its Exit.
  readonly pushHost?: (deadline: Date) => Effect.Effect<void>;
}

export const pushFailedTrailer = (detail: string) =>
  `\n\x1fproofbox-fail ${detail}\n`;

// The most of a failed push's own error the fail trailer carries.
const FAIL_DETAIL_MAX = 200;

// Runs as `sh -c <script> sh <idleSeconds> <leftSeconds> <argv...>`. The
// Deadline is set on the Sandbox's own clock, as `extend` does. A failed
// push ends the script with the fail trailer in place of the counts, as a
// failed push ended `exec` before the Keeper did it: before the command,
// the command does not run. A failed count reads as 0.
const checksScript = (shell: ChecksShell) =>
  [
    "idle=$1",
    "cap=$(( $(date +%s) + $2 ))",
    "shift 2",
    `push() { d=$(( $(date +%s) + idle )); [ "$d" -gt "$cap" ] && d=$cap; pe=$( { ${shell.push}; } 2>&1 ); }`,
    `pushfail() { printf '\\n\\037proofbox-fail %s\\n' "$(printf %s "$pe" | tr '\\n' ' ' | cut -c1-${FAIL_DETAIL_MAX})" >&2; exit 1; }`,
    "printf '\\037proofbox-start\\n' >&2",
    "push || pushfail",
    `k1=$( { ${shell.kills}; } 2>/dev/null)`,
    shell.run,
    "code=$?",
    `k2=$( { ${shell.kills}; } 2>/dev/null)`,
    "push || pushfail",
    `printf '\\n\\037proofbox-checks %s %s\\n' "\${k1:-0}" "\${k2:-0}" >&2`,
    "exit $code",
  ].join("; ");

const checksArgv = (
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
  couldStart(text, TRAILER_HEAD, /^(\d*|\d+ \d*|\d+ \d+\n)$/) ||
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

// Turns the events of a `checksScript` call into the Caller's: the start
// mark and the trailer go, and the two counts land on the Exit event. A
// fail trailer fails with `pushFailed()` and the push's own error.
// Stderr before the start mark is the runtime's own: with no mark (the
// script never started), a gone container there fails with `gone()`; any
// other text goes out as it is. After the mark, only a stderr tail that
// could start the trailer is held back, until the next chunk or the Exit.
const splitChecks = <E>(
  events: Stream.Stream<ExecEvent, E>,
  on: {
    readonly gone: () => SandboxGoneError;
    readonly pushFailed: (detail: string) => ProviderError;
  },
): Stream.Stream<ExecEvent, E | SandboxGoneError | ProviderError> =>
  Stream.suspend(() => {
    let started = false;
    let held = Buffer.alloc(0);
    const step = (
      event: ExecEvent,
    ): Effect.Effect<
      ReadonlyArray<ExecEvent>,
      SandboxGoneError | ProviderError
    > => {
      switch (event._tag) {
        case "Stdout":
          return Effect.succeed([event]);
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
          return Effect.succeed(out.length === 0 ? [] : [stderr(out)]);
        }
        case "Exit": {
          const rest = held;
          held = Buffer.alloc(0);
          if (!started) {
            if (GONE.test(rest.toString("utf8"))) {
              return Effect.fail(on.gone());
            }
            return Effect.succeed(
              rest.length === 0 ? [event] : [stderr(rest), event],
            );
          }
          const text = rest.toString("latin1");
          if (text.startsWith(FAIL_HEAD) && text.endsWith("\n")) {
            const detail = rest
              .subarray(FAIL_HEAD.length, rest.length - 1)
              .toString("utf8")
              .trim();
            return Effect.fail(on.pushFailed(detail || "the write failed"));
          }
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
    return events.pipe(
      Stream.mapEffect((event) => step(event)),
      Stream.flattenIterables,
    );
  });

// Keeps the Deadline pushed while a command runs, every third of the idle
// time. The command's own call pushes before and after it, so this only
// covers a long run; it stops with the command, never on a timer of its
// own. A failed push ends the run.
const withRunningPush =
  (connection: Connection) =>
  <A, E, R>(
    events: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | SandboxCallError, R> => {
    const every = Duration.millis(
      Duration.toMillis(Duration.seconds(connection.info.idleSeconds)) / 3,
    );
    const push = Effect.flatMap(pushedDeadline(connection.info), (deadline) =>
      connection.extend(deadline),
    );
    // The command's stream stays on the fiber that reads it: a stdin feed
    // that drains after the command exits depends on that.
    return Stream.unwrapScoped(
      Effect.map(
        Effect.forkScoped(
          Effect.forever(Effect.zipRight(Effect.sleep(every), push)),
        ),
        (pushing) => Stream.interruptWhen(events, Fiber.join(pushing)),
      ),
    );
  };

// Runs one command with its checks around it (ADR 0015).
export const runCommand = (
  connection: Connection,
  argv: ReadonlyArray<string>,
  options?: ExecOptions,
): Stream.Stream<ExecEvent, SandboxCallError> => {
  const transport = connection.transport;
  const push = transport.pushHost;
  const pushHost =
    push === undefined
      ? Effect.void
      : Effect.flatMap(pushedDeadline(connection.info), (deadline) =>
          push(deadline),
        );
  return withRunningPush(connection)(
    Stream.unwrap(
      Effect.gen(function* () {
        const nowMillis = yield* Clock.currentTimeMillis;
        yield* pushHost;
        return splitChecks(
          transport.call(
            checksArgv(
              checksScript(transport.shell),
              connection.info,
              nowMillis,
              argv,
            ),
            options,
          ),
          {
            gone: () => transport.gone(),
            pushFailed: (detail) =>
              transport.fail(`could not write the Deadline: ${detail}`),
          },
        ).pipe(
          Stream.tap((event) =>
            event._tag === "Exit" ? pushHost : Effect.void,
          ),
        );
      }),
    ),
  );
};
