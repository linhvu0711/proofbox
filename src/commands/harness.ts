import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Clock, Config, Duration, Effect, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  HarnessError,
  HarnessProfileExistsError,
  NoHarnessTokenError,
  NoSuchHarnessError,
  platformReason,
} from "../errors.ts";
import { type HarnessEntry, Harnesses } from "../harness.ts";
import { copyResolved, harnessProfilePath } from "../harness-profile.ts";
import { changeHarnessLogins } from "../login/logins-file.ts";
import { readStdinText } from "../login/stdin-token.ts";

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
      .makeDirectory(path)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SystemError" && error.reason === "AlreadyExists"
            ? new HarnessProfileExistsError({ harness: entry.name, path })
            : failed(error),
        ),
      );
    const copied: string[] = [];
    const missing: string[] = [];
    for (const part of entry.profile.parts) {
      if (yield* fs.exists(join(from, part)).pipe(Effect.mapError(failed))) {
        yield* copyResolved(entry.name, join(from, part), join(path, part));
        copied.push(part);
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
      if (missing.length > 0) {
        yield* output.err(
          `Not on this laptop, skipped: ${missing.join(", ")}.\n`,
        );
      }
    }
    yield* output.err(
      `Not copied: ${entry.profile.leftOut}. They can point to programs on this laptop or hold tokens.\n`,
    );
  },
);
