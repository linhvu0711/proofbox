import { Clock, Config, Effect, Option } from "effect";
import { LoginExpiredError, NotLoggedInError } from "../errors.ts";
import type { ProviderLogin } from "../provider.ts";
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
// expiresAt is an expired one.
export const loginFor = (provider: string): ProviderLogin =>
  Effect.gen(function* () {
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
    // A browser login holds no token to hand over yet; the trade lands
    // in #49's later slice.
    if (saved.way === "browser") {
      return yield* new NotLoggedInError({ provider });
    }
    return { token: saved.token, region: Option.fromNullable(saved.region) };
  });
