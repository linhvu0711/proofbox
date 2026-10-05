import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Clock, Config, Duration, Effect, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import { parseSpan } from "../deadline.ts";
import {
  EmptyPromptError,
  HarnessError,
  HarnessProfileExistsError,
  NoHarnessTokenError,
  NoSuchHarnessError,
  NoTurnYetError,
  NotHarnessSandboxError,
  platformReason,
  TurnRunningError,
} from "../errors.ts";
import { formatTime } from "../format-time.ts";
import { type HarnessEntry, Harnesses } from "../harness.ts";
import { copyResolved, harnessProfilePath } from "../harness-profile.ts";
import { changeHarnessLogins } from "../login/logins-file.ts";
import { readStdinText } from "../login/stdin-token.ts";
import {
  readTurn,
  settleTurn,
  startTurn,
  stopTurn,
  TURN_EXIT,
} from "../turn.ts";

export const harnessEntryFor = Effect.fn("harness.harnessEntryFor")(function* (
  name: string,
) {
  const harnesses = yield* Harnesses;
  const entry = harnesses.get(name);
  if (entry === undefined) {
    return yield* new NoSuchHarnessError({
      harness: name,
      known: [...harnesses.keys()],
    });
  }
  return entry;
});

export const saveHarnessLogin = Effect.fn("harness.saveHarnessLogin")(
  function* (entry: HarnessEntry, raw: string) {
    const token = raw.trim();
    if (token === "") {
      return yield* new NoHarnessTokenError({
        harness: entry.name,
        what: entry.login.what,
        placeholder: entry.login.placeholder,
        howToMake: entry.login.howToMake,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    yield* changeHarnessLogins((logins) => ({
      ...logins,
      [entry.name]: {
        token: Redacted.make(token),
        ...(Option.isSome(entry.login.lifetime)
          ? {
              expiresAt: new Date(
                now + Duration.toMillis(entry.login.lifetime.value),
              ),
            }
          : {}),
      },
    }));
    const output = yield* CliOutput;
    yield* output.err(
      `Saved Harness login for ${entry.name} with ${entry.login.what} …${token.slice(-4)}.\n`,
    );
  },
);

export const loginToHarness = Effect.fn("harness.loginToHarness")(function* (
  name: string,
) {
  const entry = yield* harnessEntryFor(name);
  const raw = yield* readStdinText();
  yield* saveHarnessLogin(entry, raw);
});

export const promptHarness = Effect.fn("harness.promptHarness")(function* (
  rawId: string,
  prompt: string,
  model: Option.Option<string>,
) {
  if (prompt.trim() === "") return yield* new EmptyPromptError();
  const turn = yield* readTurn(rawId, 0);
  if (Option.isNone(turn.harness))
    return yield* new NotHarnessSandboxError({ id: rawId });
  if (turn.state._tag === "Running") return yield* new TurnRunningError();
  const entry = yield* harnessEntryFor(turn.harness.value);
  const harness = yield* entry.load;
  let session = turn.session;
  if (turn.state._tag === "Ended") {
    yield* settleTurn(rawId, turn.files, harness, turn.state);
    session = (yield* readTurn(rawId, 0)).session;
  }
  const output = yield* CliOutput;
  const started = yield* startTurn(
    rawId,
    harness.turn({ prompt, model, session }),
  ).pipe(
    Effect.as(true),
    Effect.catchTag("HarnessError", (error) =>
      Effect.gen(function* () {
        yield* output.err(`${error.reason}\n`);
        yield* output.setExitCode(125);
        return false;
      }),
    ),
  );
  if (!started) return;
  yield* output.err(
    `proofbox: turn started; run proofbox harness wait ${rawId}\n`,
  );
}, Effect.scoped);

export const waitForTurn = Effect.fn("harness.waitForTurn")(function* (
  rawId: string,
  timeout: Option.Option<string>,
) {
  const span = Option.isSome(timeout)
    ? yield* parseSpan("timeout", timeout.value)
    : undefined;
  const until =
    span === undefined
      ? undefined
      : (yield* Clock.currentTimeMillis) + Duration.toMillis(span);
  const output = yield* CliOutput;
  while (true) {
    const left =
      until === undefined
        ? 5
        : Math.max(
            0,
            Math.floor((until - (yield* Clock.currentTimeMillis)) / 1000),
          );
    const turn = yield* readTurn(rawId, Math.min(5, left));
    if (Option.isNone(turn.harness))
      return yield* new NotHarnessSandboxError({ id: rawId });
    if (turn.state._tag === "Running") {
      if (until === undefined || (yield* Clock.currentTimeMillis) < until)
        continue;
      const entry = yield* harnessEntryFor(turn.harness.value);
      const harness = yield* entry.load;
      const activity = harness.readActivity(turn.state.output);
      yield* output.out(
        `still running\nlast activity: ${formatTime(turn.state.activityAt)}\nlast: ${Option.getOrElse(activity, () => "nothing yet")}\n`,
      );
      yield* output.setExitCode(TURN_EXIT.stillRunning);
      return;
    }
    if (turn.state._tag === "Saved") {
      yield* output.out(turn.state.text);
      yield* output.setExitCode(turn.state.code);
      return;
    }
    if (turn.state._tag === "Stopped") {
      yield* output.out("stopped\n");
      yield* output.setExitCode(TURN_EXIT.stopped);
      return;
    }
    if (turn.state._tag !== "Ended")
      return yield* new NoTurnYetError({ id: rawId });
    const entry = yield* harnessEntryFor(turn.harness.value);
    const harness = yield* entry.load;
    const result = yield* settleTurn(rawId, turn.files, harness, turn.state);
    yield* output.out(result.text);
    yield* output.setExitCode(result.code);
    return;
  }
}, Effect.scoped);

export const stopHarnessTurn = Effect.fn("harness.stopHarnessTurn")(function* (
  rawId: string,
) {
  const state = yield* stopTurn(rawId);
  if (state === "no-harness")
    return yield* new NotHarnessSandboxError({ id: rawId });
  const output = yield* CliOutput;
  yield* output.err(
    state === "stopped"
      ? "proofbox: stopped the turn\n"
      : "proofbox: no turn is running\n",
  );
}, Effect.scoped);

export const initHarnessProfile = Effect.fn("harness.initHarnessProfile")(
  function* (name: string) {
    const entry = yield* harnessEntryFor(name);
    const path = yield* harnessProfilePath(entry.name);
    const from = join(yield* Config.string("HOME"), entry.profile.home);
    const fs = yield* FileSystem.FileSystem;
    const failed = (error: Parameters<typeof platformReason>[0]) =>
      new HarnessError({ harness: entry.name, reason: platformReason(error) });
    yield* fs
      .makeDirectory(dirname(path), { recursive: true })
      .pipe(Effect.mapError(failed));
    yield* fs
      .makeDirectory(path, { mode: 0o700 })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SystemError" && error.reason === "AlreadyExists"
            ? new HarnessProfileExistsError({ harness: entry.name, path })
            : failed(error),
        ),
      );
    const copied: string[] = [];
    const missing: string[] = [];
    const skipped: string[] = [];
    for (const part of entry.profile.parts) {
      const partName = part.replace(/\/$/, "");
      const source = join(from, partName);
      const link = yield* fs.readLink(source).pipe(Effect.option);
      if (
        Option.isSome(link) ||
        (yield* fs.exists(source).pipe(Effect.mapError(failed)))
      ) {
        const skippedPart = yield* copyResolved(
          entry.name,
          source,
          join(path, partName),
          from,
        );
        skipped.push(...skippedPart);
        if (!skippedPart.includes(partName)) {
          copied.push(part);
        }
      } else {
        missing.push(part);
      }
    }
    const output = yield* CliOutput;
    yield* output.out(`${path}\n`);
    if (copied.length === 0) {
      yield* output.err(
        `Copied nothing: ${from} has none of ${entry.profile.parts.join(", ")}. The profile is empty.\n`,
      );
    } else {
      yield* output.err(`Copied from ${from}: ${copied.join(", ")}.\n`);
    }
    if (missing.length > 0 && (copied.length > 0 || skipped.length > 0)) {
      yield* output.err(
        `Not on this laptop, skipped: ${missing.join(", ")}.\n`,
      );
    }
    if (skipped.length > 0) {
      yield* output.err(
        `Skipped links that lead nowhere or loop: ${skipped.sort().join(", ")}.\n`,
      );
    }
    yield* output.err(
      `Not copied: ${entry.profile.leftOut}. They can point to programs on this laptop or hold tokens.\n`,
    );
  },
);
