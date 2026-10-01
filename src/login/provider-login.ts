import { Clock, Config, Effect, Option, type Redacted } from "effect";
import {
  LoginExpiredError,
  NotLoggedInError,
  type ProviderError,
  type ProviderUnavailableError,
} from "../errors.ts";
import { readLogins } from "./logins-file.ts";

export const envTokenName = (provider: string) =>
  `PROOFBOX_${provider.toUpperCase()}_TOKEN`;

export const envRegionName = (provider: string) =>
  `PROOFBOX_${provider.toUpperCase()}_REGION`;

export const envToken = (provider: string) =>
  Config.option(Config.redacted(envTokenName(provider)));

export const envRegion = (provider: string) =>
  Config.option(Config.string(envRegionName(provider)));

// The env token wins over the saved login; a saved login past its
// expiresAt is an expired one. A browser login holds a session, which
// `trade` turns into the token commands act with.
export const loginFor = Effect.fn("providerLogin.loginFor")(function* (
  provider: string,
  trade?: (
    session: Redacted.Redacted<string>,
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    ProviderError | ProviderUnavailableError | LoginExpiredError
  >,
) {
  // A redacted string can never fail to load, so `option` yields None
  // for a missing variable and anything else is a defect.
  const env = yield* Effect.orDie(envToken(provider));
  if (Option.isSome(env)) {
    const region = yield* Effect.orDie(envRegion(provider));
    return { token: env.value, region };
  }
  // HOME missing cannot give a saved login to read.
  const logins = yield* readLogins.pipe(
    Effect.catchTag("ConfigError", () => new NotLoggedInError({ provider })),
  );
  const saved = logins[provider];
  if (saved === undefined) {
    return yield* new NotLoggedInError({ provider });
  }
  const now = yield* Clock.currentTimeMillis;
  if (saved.expiresAt !== undefined && saved.expiresAt.getTime() <= now) {
    return yield* new LoginExpiredError({ provider });
  }
  if (saved.way === "browser") {
    // A browser slot is no token yet; without a trade it logs in nowhere.
    if (trade === undefined) {
      return yield* new NotLoggedInError({ provider });
    }
    return {
      token: yield* trade(saved.session),
      region: Option.fromNullable(saved.region),
    };
  }
  return { token: saved.token, region: Option.fromNullable(saved.region) };
});
