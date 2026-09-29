import { Clock, Config, Effect, Option } from "effect";
import { LoginExpiredError, NotLoggedInError } from "../errors.ts";
import type { ProviderLogin } from "../provider.ts";
import { readLogins } from "./logins-file.ts";

export const envTokenName = (provider: string) =>
  `PROOFBOX_${provider.toUpperCase()}_TOKEN`;

export const envToken = (provider: string) =>
  Config.option(Config.redacted(envTokenName(provider)));

// The env token wins over the saved login; a saved login past its
// expiresAt is an expired one.
export const loginFor = (provider: string): ProviderLogin =>
  Effect.gen(function* () {
    // A redacted string can never fail to load, so `option` yields None
    // for a missing variable and anything else is a defect.
    const env = yield* Effect.orDie(envToken(provider));
    if (Option.isSome(env)) {
      return env.value;
    }
    // HOME missing cannot give a saved login to read.
    const logins = yield* readLogins.pipe(
      Effect.catchTag("ConfigError", () =>
        new NotLoggedInError({ provider }),
      ),
    );
    const saved = logins[provider];
    if (saved === undefined) {
      return yield* new NotLoggedInError({ provider });
    }
    const now = yield* Clock.currentTimeMillis;
    if (saved.expiresAt.getTime() <= now) {
      return yield* new LoginExpiredError({ provider });
    }
    return saved.token;
  });
