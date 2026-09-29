import { text } from "node:stream/consumers";
import { Clock, Effect, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  ExternalLoginError,
  NoLoginNeededError,
  NoLoginWayError,
  NoSuchProviderError,
  NoTokenError,
  ProviderError,
} from "../errors.ts";
import { formatTime } from "../format-time.ts";
import { readLogins, saveLogins } from "../login/logins-file.ts";
import { envToken, envTokenName } from "../login/provider-login.ts";
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
    if (part._tag === "External") {
      return yield* new ExternalLoginError({
        provider: provider.name,
        tool: part.tool,
      });
    }
    return { provider, part } as const;
  });

export const loginToProvider = (options: {
  readonly provider: string;
  readonly token: boolean;
}) =>
  Effect.gen(function* () {
    const { provider, part } = yield* loginPartFor(options.provider);
    // --token picks the token way; with no flag the browser way is the
    // default (#49). A Provider that lacks the picked way refuses.
    const way: LoginWay = options.token ? "token" : "browser";
    if (!part.ways.has(way)) {
      return yield* new NoLoginWayError({ provider: provider.name, way });
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
    const account = yield* part.checkToken(Redacted.make(token));
    const logins = yield* readLogins;
    const previous = logins[provider.name];
    yield* saveLogins({
      ...logins,
      [provider.name]: {
        way: "token",
        token: Redacted.make(token),
        account: account.account,
        expiresAt: account.expiresAt,
      },
    });
    const output = yield* CliOutput;
    yield* output.err(
      previous === undefined
        ? `Logged in to ${provider.name} as ${account.account}.\n`
        : `Logged in to ${provider.name} as ${account.account} (replaced ${previous.account}).\n`,
    );
  });

export const showAuthStatus = Effect.gen(function* () {
  const providers = yield* Providers;
  const logins = yield* readLogins;
  const output = yield* CliOutput;
  const now = yield* Clock.currentTimeMillis;
  for (const provider of providers.values()) {
    const part = provider.login;
    let line: string;
    if (part._tag === "None") {
      line = "no login needed";
    } else if (part._tag === "External") {
      line = `logs in with ${part.tool} for now`;
    } else {
      const env = yield* envToken(provider.name);
      if (Option.isSome(env)) {
        line = yield* part.checkToken(env.value).pipe(
          Effect.map(
            (account) =>
              `logged in as ${account.account}, expires ${formatTime(account.expiresAt)}, env token ${envTokenName(provider.name)}`,
          ),
          Effect.catchTag("TokenRejectedError", () =>
            Effect.succeed(
              `${envTokenName(provider.name)} is set, but ${provider.name} did not accept it`,
            ),
          ),
        );
      } else {
        const saved = logins[provider.name];
        if (saved === undefined) {
          line = "not logged in";
        } else if (saved.expiresAt.getTime() <= now) {
          line = `expired ${formatTime(saved.expiresAt)}. Run: proofbox auth login ${provider.name}`;
        } else {
          line = `logged in as ${saved.account}, expires ${formatTime(saved.expiresAt)}, saved login`;
        }
      }
    }
    yield* output.out(`${provider.name}  ${line}\n`);
  }
});
