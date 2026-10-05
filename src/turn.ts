import { randomUUID } from "node:crypto";
import { Effect, Option, Stream } from "effect";
import { HarnessError, TurnRunningError } from "./errors.ts";
import type { Harness } from "./harness.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { Providers } from "./provider.ts";
import {
  type SandboxFiles,
  sandboxFiles,
  writeSandboxFile,
} from "./sandbox-file.ts";
import { resolveSandboxId } from "./sandbox-id.ts";
import { withSecrets } from "./secrets.ts";

const START = `set -eu
umask 077
t=$1; shift
l="$t.lock"
if ! err=$(mkdir "$l" 2>&1); then
  if [ ! -d "$l" ]; then echo "error $err"; exit 1; fi
  age=$(( $(date +%s) - $(perl -e 'print +(stat shift)[9]' "$l") ))
  if [ "$age" -le 30 ]; then echo running; exit 0; fi
  rmdir "$l" 2>/dev/null || true
  if ! mkdir "$l" 2>/dev/null; then echo running; exit 0; fi
fi
trap 'rmdir "$l"' EXIT
if [ -f "$t/pid" ] && [ ! -f "$t/exit" ] && [ ! -f "$t/stopped" ] && kill -0 "$(cat "$t/pid")" 2>/dev/null; then
  echo running
  exit 0
fi
rm -rf "$t"; mkdir -p "$t"
(trap '' HUP; exec perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; exec @ARGV or die' \\
  sh -c 't=$1; shift; "$@" > "$t/out" 2> "$t/err"; echo "$?" > "$t/exit.tmp"; mv "$t/exit.tmp" "$t/exit"' \\
  sh "$t" "$@") < /dev/null > /dev/null 2>&1 &
echo "$!" > "$t/pid"
`;

const READ = `set -eu
h=$1; t=$2; s=$3; seconds=$4; marker=$5
if [ ! -f "$h" ]; then echo no-harness; exit; fi
head -n 1 "$h"
if [ -f "$s" ]; then head -n 1 "$s"; else echo; fi
if [ ! -f "$t/pid" ]; then echo none; exit; fi
pid=$(cat "$t/pid")
while [ "$seconds" -gt 0 ] && [ ! -f "$t/exit" ] && [ ! -f "$t/stopped" ] && kill -0 "$pid" 2>/dev/null; do
  sleep 1
  seconds=$((seconds - 1))
done
if [ -f "$t/result" ]; then echo saved; cat "$t/result"; exit; fi
if [ -f "$t/stopped" ]; then echo stopped; exit; fi
if [ -f "$t/exit" ]; then
  echo "ended $(cat "$t/exit")"
elif kill -0 "$pid" 2>/dev/null; then
  printf 'running '
  perl -e 'print +(stat shift)[9] || time' "$t/out"
  echo
else
  echo 'ended none'
fi
if [ -f "$t/out" ]; then tail -n 50 "$t/out" | tail -c 1048576; fi
printf '%s\\n' "$marker"
if [ -f "$t/err" ]; then tail -n 20 "$t/err"; fi
`;

const STOP = `set -eu
h=$1; t=$2
if [ ! -f "$h" ]; then echo no-harness; exit; fi
if [ ! -f "$t/pid" ] || [ -f "$t/exit" ] || [ -f "$t/stopped" ]; then echo idle; exit; fi
pid=$(cat "$t/pid")
if ! kill -0 "$pid" 2>/dev/null; then echo idle; exit; fi
: > "$t/stopped"
kill -TERM "-$pid" 2>/dev/null || true
seconds=10
while [ "$seconds" -gt 0 ] && kill -0 "-$pid" 2>/dev/null; do
  sleep 1
  seconds=$((seconds - 1))
done
kill -KILL "-$pid" 2>/dev/null || true
echo stopped
`;

export type TurnState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Saved"; readonly code: number; readonly text: string }
  | { readonly _tag: "Stopped" }
  | {
      readonly _tag: "Running";
      readonly activityAt: Date;
      readonly output: string;
    }
  | {
      readonly _tag: "Ended";
      readonly exit: Option.Option<number>;
      readonly output: string;
      readonly errLines: string;
    };

export const TURN_EXIT = {
  done: 0,
  stopped: 20,
  login: 21,
  usageLimit: 22,
  crash: 23,
  stillRunning: 124,
} as const;

export const runTurnScript = Effect.fn("turn.runTurnScript")(function* (
  rawId: string,
  argv: ReadonlyArray<string>,
) {
  const keeper = yield* KeeperClient;
  const events = yield* keeper.exec(rawId, argv);
  const chunks: Uint8Array[] = [];
  let code = 0;
  yield* events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event._tag === "Stdout") chunks.push(event.bytes);
        if (event._tag === "Exit") code = event.code;
      }),
    ),
  );
  return { code, out: Buffer.concat(chunks).toString("utf8") };
});

const turnFiles = Effect.fn("turn.turnFiles")(function* (rawId: string) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const keeper = yield* KeeperClient;
  const info = yield* keeper.info(rawId);
  return sandboxFiles(id.provider, id.name, info.os);
});

export const readTurn = Effect.fn("turn.readTurn")(function* (
  rawId: string,
  waitSeconds: number,
) {
  const files = yield* turnFiles(rawId);
  const marker = randomUUID();
  const result = yield* runTurnScript(rawId, [
    "sh",
    "-c",
    READ,
    "sh",
    files.harness,
    files.turn,
    files.session,
    String(waitSeconds),
    marker,
  ]);
  if (result.code !== 0) {
    return yield* new HarnessError({
      harness: rawId,
      reason: `could not read the Turn (exit code ${result.code})`,
    });
  }
  const [name = "", session = "", status = "", ...rest] =
    result.out.split("\n");
  const body = rest.join("\n");
  const separator = body.lastIndexOf(`${marker}\n`);
  const output = separator < 0 ? body : body.slice(0, separator);
  const errLines =
    separator < 0 ? "" : body.slice(separator + marker.length + 1);
  let state: TurnState;
  if (name === "no-harness" || status === "none") state = { _tag: "None" };
  else if (status === "saved") {
    const newline = body.indexOf("\n");
    state = {
      _tag: "Saved",
      code: Number(body.slice(0, newline)),
      text: body.slice(newline + 1),
    };
  } else if (status === "stopped") state = { _tag: "Stopped" };
  else if (status.startsWith("running "))
    state = {
      _tag: "Running",
      activityAt: new Date(Number(status.slice(8)) * 1000),
      output,
    };
  else if (status.startsWith("ended "))
    state = {
      _tag: "Ended",
      exit:
        status === "ended none"
          ? Option.none()
          : Option.some(Number(status.slice(6))),
      output,
      errLines,
    };
  else
    return yield* new HarnessError({
      harness: name,
      reason: "could not read the Turn state",
    });
  return {
    files,
    harness: name === "no-harness" ? Option.none<string>() : Option.some(name),
    session: session === "" ? Option.none<string>() : Option.some(session),
    state,
  };
});

export const startTurn = Effect.fn("turn.startTurn")(function* (
  rawId: string,
  argv: ReadonlyArray<string>,
) {
  const files = yield* turnFiles(rawId);
  const result = yield* runTurnScript(
    rawId,
    withSecrets(files.secrets, ["sh", "-c", START, "sh", files.turn, ...argv]),
  );
  const state = result.out.trim();
  if (state === "running") return yield* new TurnRunningError();
  if (state.startsWith("error "))
    return yield* new HarnessError({
      harness: rawId,
      reason: `could not start the Turn: ${state.slice(6)}`,
    });
  if (result.code !== 0)
    return yield* new HarnessError({
      harness: rawId,
      reason: `could not start the Turn (exit code ${result.code})`,
    });
});

export const stopTurn = Effect.fn("turn.stopTurn")(function* (rawId: string) {
  const files = yield* turnFiles(rawId);
  const result = yield* runTurnScript(rawId, [
    "sh",
    "-c",
    STOP,
    "sh",
    files.harness,
    files.turn,
  ]);
  const state = result.out.trim();
  if (
    result.code !== 0 ||
    (state !== "no-harness" && state !== "idle" && state !== "stopped")
  ) {
    return yield* new HarnessError({
      harness: rawId,
      reason: `could not stop the Turn (exit code ${result.code})`,
    });
  }
  return state;
});

export const endText = (
  harness: Harness,
  exit: Option.Option<number>,
  output: string,
  errLines: string,
) => {
  const end = harness.readEnd(output);
  if (end._tag === "Done" && Option.isSome(exit) && exit.value === 0)
    return {
      code: TURN_EXIT.done,
      text: `done\n${end.lastMessage}\n`,
      session: Option.some(end.session),
    };
  if (end._tag === "Failed") {
    if (end.kind === "login")
      return {
        code: TURN_EXIT.login,
        text: `failed: Harness login refused: ${end.message}\nfix: run proofbox harness login ${harness.name}, then make a new Sandbox with proofbox create --harness ${harness.name}\n`,
        session: end.session,
      };
    if (end.kind === "usage-limit")
      return {
        code: TURN_EXIT.usageLimit,
        text: `failed: usage limit: ${end.message}\n${Option.isSome(end.resets) ? `resets: ${end.resets.value}\n` : ""}fix: wait for the reset, then send the next prompt\n`,
        session: end.session,
      };
    return {
      code: TURN_EXIT.crash,
      text: `failed: Harness crashed: ${end.message}\n${errLines}fix: read the lines above, then send the next prompt\n`,
      session: end.session,
    };
  }
  return {
    code: TURN_EXIT.crash,
    text: `failed: Harness crashed ${Option.isSome(exit) ? `with exit code ${exit.value}` : "with no exit code"}\n${errLines}fix: read the lines above, then send the next prompt\n`,
    session:
      end._tag === "Done" ? Option.some(end.session) : Option.none<string>(),
  };
};

export const settleTurn = Effect.fn("turn.settleTurn")(function* (
  rawId: string,
  files: SandboxFiles,
  harness: Harness,
  state: Extract<TurnState, { readonly _tag: "Ended" }>,
) {
  const result = endText(harness, state.exit, state.output, state.errLines);
  if (Option.isSome(result.session)) {
    const code = yield* writeSandboxFile(
      rawId,
      files.session,
      new TextEncoder().encode(`${result.session.value}\n`),
      { executable: false },
    );
    if (code !== 0)
      return yield* new HarnessError({
        harness: harness.name,
        reason: `could not save the Harness session (exit code ${code})`,
      });
  }
  const code = yield* writeSandboxFile(
    rawId,
    `${files.turn}/result`,
    new TextEncoder().encode(`${result.code}\n${result.text}`),
    { executable: false },
  );
  if (code !== 0)
    return yield* new HarnessError({
      harness: harness.name,
      reason: `could not save the Turn result (exit code ${code})`,
    });
  return result;
});
