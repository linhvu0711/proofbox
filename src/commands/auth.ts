import { text } from "node:stream/consumers";
import { Clock, Effect, Either, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  NoLoginNeededError,
  NoLoginWayError,
  NoRegionsError,
  NoSuchProviderError,
  NoTokenError,
  ProviderError,
  UnknownRegionError,
} from "../errors.ts";
import { formatTime } from "../format-time.ts";
import {
  changeLogins,
  readLogins,
  type SavedLogin,
} from "../login/logins-file.ts";
import { envRegion, envToken, envTokenName } from "../login/provider-login.ts";
import { type LoginWay, Providers } from "../provider.ts";

// The Provider plus its Ways login part, or the refusal to print.
const loginPartFor = (name: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const provider = providers.get(name);
    if (provider === undefined) {
      return yield* new NoSuchProviderError({
        provider: name,
        known: [...providers.keys()],
      });
    }
    const part = provider.login;
    if (part._tag === "None") {
      return yield* new NoLoginNeededError({ provider: provider.name });
    }
    return { provider, part } as const;
  });

export const loginToProvider = (options: {
  readonly provider: string;
  readonly token: boolean;
  readonly region: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const { provider, part } = yield* loginPartFor(options.provider);
    // --token picks the token way; with no flag the browser way is the
    // default (#49). A Provider that lacks the picked way refuses.
    const way: LoginWay = options.token ? "token" : "browser";
    if (!part.ways.has(way)) {
      return yield* new NoLoginWayError({ provider: provider.name, way });
    }
    // A region only makes sense where the Provider names regions; both
    // checks run before the token is read from stdin.
    if (Option.isSome(options.region)) {
      if (provider.regions === undefined) {
        return yield* new NoRegionsError({ provider: provider.name });
      }
      if (!provider.regions.known.includes(options.region.value)) {
        return yield* new UnknownRegionError({
          provider: provider.name,
          region: options.region.value,
          known: provider.regions.known,
        });
      }
    }
    const raw = yield* Effect.tryPromise({
      try: () => text(process.stdin),
      catch: (cause) =>
        new ProviderError({
          provider: "local",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const token = raw.trim();
    if (token === "") {
      return yield* new NoTokenError({ provider: provider.name });
    }
    const account = yield* part.checkToken(
      Redacted.make(token),
      options.region,
    );
    const before = yield* changeLogins((logins) => ({
      ...logins,
      [provider.name]: {
        way: "token",
        token: Redacted.make(token),
        account: account.account,
        expiresAt: account.expiresAt,
        ...(Option.isSome(options.region)
          ? { region: options.region.value }
          : {}),
      },
    }));
    const previous = before[provider.name];
    const output = yield* CliOutput;
    yield* output.err(
      previous === undefined
        ? `Logged in to ${provider.name} as ${account.account}.\n`
        : `Logged in to ${provider.name} as ${account.account} (replaced ${previous.account}).\n`,
    );
  });

export const showAuthStatus = Effect.gen(function* () {
  const providers = yield* Providers;
  const logins = yield* Effect.cached(readLogins);
  const output = yield* CliOutput;
  const now = yield* Clock.currentTimeMillis;
  for (const provider of providers.values()) {
    const part = provider.login;
    let line: string;
    if (part._tag === "None") {
      line = "no login needed";
    } else {
      // A regional Provider names the login's region, or its fallback
      // when the login carries none.
      const regions = provider.regions;
      const regionOf = (region: Option.Option<string>) =>
        regions === undefined
          ? ""
          : `, region ${Option.getOrElse(region, () => regions.fallback)}`;
      const env = yield* envToken(provider.name);
      if (Option.isSome(env)) {
        const region = yield* envRegion(provider.name);
        line = yield* part.checkToken(env.value, region).pipe(
          Effect.map(
            (account) =>
              `logged in as ${account.account}${regionOf(region)}, expires ${formatTime(account.expiresAt)}, env token ${envTokenName(provider.name)}`,
          ),
          Effect.catchTag("TokenRejectedError", () =>
            Effect.succeed(
              `${envTokenName(provider.name)} is set, but ${provider.name} did not accept it`,
            ),
          ),
        );
      } else {
        // A logins file that cannot be read counts as no saved login.
        const saved = (yield* logins.pipe(
          Effect.catchAll(() => Effect.succeed<Record<string, SavedLogin>>({})),
        ))[provider.name];
        if (saved === undefined) {
          line = "not logged in";
        } else if (saved.expiresAt.getTime() <= now) {
          line = `expired ${formatTime(saved.expiresAt)}. Run: proofbox auth login ${provider.name}`;
        } else {
          line = `logged in as ${saved.account}${regionOf(Option.fromNullable(saved.region))}, expires ${formatTime(saved.expiresAt)}, saved login`;
        }
      }
    }
    yield* output.out(`${provider.name}  ${line}\n`);
  }
});

// Logout lists the still-running Sandboxes as the result, removes the
// saved slot whatever `list` gives, and says what it did on stderr.
export const logoutOfProvider = (name: string) =>
  Effect.gen(function* () {
    const { provider } = yield* loginPartFor(name);
    const output = yield* CliOutput;
    const logins = yield* readLogins;
    if (logins[provider.name] === undefined) {
      yield* output.err(`No saved login for ${provider.name}.\n`);
      return;
    }
    const listed = yield* Effect.either(provider.list);
    const before = yield* changeLogins((saved) => {
      const rest = { ...saved };
      delete rest[provider.name];
      return rest;
    });
    if (before[provider.name] === undefined) {
      yield* output.err(`No saved login for ${provider.name}.\n`);
      return;
    }
    if (Either.isLeft(listed)) {
      yield* output.err(
        `Logged out of ${provider.name}. Could not check for running Sandboxes. Any left stop at their Deadline.\n`,
      );
      return;
    }
    const infos = listed.right;
    const note =
      infos.length === 0
        ? ""
        : infos.length === 1
          ? " 1 Sandbox still runs. It stops at its Deadline."
          : ` ${infos.length} Sandboxes still run. They stop at their Deadline.`;
    yield* output.err(`Logged out of ${provider.name}.${note}\n`);
    for (const info of infos) {
      yield* output.out(`${provider.idPrefix}:${info.name}\n`);
    }
  });
