import { Clock, Duration, Effect, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import { NoHarnessTokenError, NoSuchHarnessError } from "../errors.ts";
import { type HarnessEntry, Harnesses } from "../harness.ts";
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
