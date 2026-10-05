import { text } from "node:stream/consumers";
import { Clock, Config, Duration, Effect, Option, Redacted } from "effect";
import { CliOutput } from "../cli-output.ts";
import { parseSpan, TOKEN_SPAN } from "../deadline.ts";
import {
  BadTokenFlagError,
  LoginExpiredError,
  LoginTimeoutError,
  NoLoginNeededError,
  NoLoginWayError,
  NoRegionsError,
  NoSuchProviderError,
  NoTokenError,
  NoTokenMakingError,
  NotLoggedInError,
  ProviderError,
  UnknownRegionError,
} from "../errors.ts";
import { formatTime } from "../format-time.ts";
import { type LogoutFailure, logOut } from "../local-sandboxes.ts";
import {
  changeLogins,
  readLogins,
  type SavedLogin,
} from "../login/logins-file.ts";
import { openBrowser } from "../login/open-browser.ts";
import { envRegion, envToken, envTokenName } from "../login/provider-login.ts";
import { Providers } from "../provider.ts";

// The Provider plus its Ways login part, or the refusal to print.
const loginPartFor = Effect.fn("auth.loginPartFor")(function* (name: string) {
  const providers = yield* Providers;
  const entry = providers.get(name);
  if (entry === undefined) {
    return yield* new NoSuchProviderError({
      provider: name,
      known: [...providers.keys()],
    });
  }
  const provider = yield* entry.load;
  const part = provider.login;
  if (part._tag === "None") {
    return yield* new NoLoginNeededError({ provider: provider.name });
  }
  return { provider, part } as const;
});

// How long a browser login waits for the click.
const loginWait = Config.string("PROOFBOX_LOGIN_WAIT").pipe(
  Config.withDefault("10m"),
);

// A saved login's name in the replaced note: its account, or the
// token's last four when it has none.
const nameOf = (login: SavedLogin) =>
  login.account ??
  (login.way === "token"
    ? `token …${Redacted.value(login.token).slice(-4)}`
    : "the old login");

export const loginToProvider = Effect.fn("auth.loginToProvider")(
  function* (options: {
    readonly provider: string;
    readonly token: boolean;
    readonly region: Option.Option<string>;
  }) {
    const { provider, part } = yield* loginPartFor(options.provider);
    // A region only makes sense where the Provider names regions; both
    // checks run first for both ways.
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
    const output = yield* CliOutput;
    if (options.token) {
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
          ...(account.account !== undefined
            ? { account: account.account }
            : {}),
          ...(account.expiresAt !== undefined
            ? { expiresAt: account.expiresAt }
            : {}),
          ...(Option.isSome(options.region)
            ? { region: options.region.value }
            : {}),
        },
      }));
      const previous = before[provider.name];
      const who =
        account.account !== undefined
          ? `as ${account.account}`
          : `with token …${token.slice(-4)}`;
      const replaced =
        previous === undefined ? "" : ` (replaced ${nameOf(previous)})`;
      yield* output.err(`Logged in to ${provider.name} ${who}${replaced}.\n`);
      return;
    }
    // With no --token the browser way is the default; a Provider that
    // lacks it refuses.
    const browser = part.browser;
    if (browser === undefined) {
      return yield* new NoLoginWayError({
        provider: provider.name,
        way: "browser",
      });
    }
    const started = yield* browser.start;
    const opened = yield* openBrowser(started.url);
    if (!opened) {
      yield* output.err(
        `Could not open a browser. Open this link on any device: ${started.url}\n`,
      );
    }
    yield* output.err(
      "Waiting for you to log in in the browser... (Ctrl+C to stop)\n",
    );
    const waitText = yield* loginWait.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: provider.name, reason: error.message }),
      ),
    );
    const wait = yield* parseSpan("PROOFBOX_LOGIN_WAIT", waitText);
    const done = yield* browser.complete(started.loginId).pipe(
      Effect.timeoutFail({
        duration: wait,
        onTimeout: () =>
          new LoginTimeoutError({ provider: provider.name, wait: waitText }),
      }),
    );
    const before = yield* changeLogins((logins) => ({
      ...logins,
      [provider.name]: {
        way: "browser",
        session: done.session,
        account: done.account,
        expiresAt: done.expiresAt,
        ...(Option.isSome(options.region)
          ? { region: options.region.value }
          : {}),
      },
    }));
    const previous = before[provider.name];
    const replaced =
      previous === undefined ? "" : ` (replaced ${nameOf(previous)})`;
    yield* output.err(
      `Logged in to ${provider.name} as ${done.account}${replaced}.\n`,
    );
  },
);

// A CI token for the Provider, minted from the saved browser login and
// printed once on stdout. The env token is never read: it cannot make
// tokens.
export const makeRobotToken = Effect.fn("auth.makeRobotToken")(
  function* (options: {
    readonly provider: string;
    readonly name: Option.Option<string>;
    readonly expires: Option.Option<string>;
  }) {
    const { provider, part } = yield* loginPartFor(options.provider);
    const makeToken = part.browser?.makeToken;
    if (makeToken === undefined) {
      return yield* new NoTokenMakingError({ provider: provider.name });
    }
    const name = Option.getOrElse(options.name, () => "");
    if (name === "") {
      return yield* new BadTokenFlagError({ flag: "name" });
    }
    if (Option.isNone(options.expires)) {
      return yield* new BadTokenFlagError({ flag: "expires" });
    }
    const span = yield* parseSpan(
      "expires",
      options.expires.value,
      TOKEN_SPAN,
    ).pipe(
      Effect.catchTag(
        "BadSpanError",
        () => new BadTokenFlagError({ flag: "expires" }),
      ),
    );
    // Namespace caps a token's life at one year (365 days).
    if (Duration.toMillis(span) > 31_536_000_000) {
      return yield* new BadTokenFlagError({ flag: "expires" });
    }
    const logins = yield* readLogins.pipe(
      Effect.catchTag(
        "ConfigError",
        () => new NotLoggedInError({ provider: provider.name }),
      ),
    );
    const saved = logins[provider.name];
    if (saved === undefined || saved.way !== "browser") {
      return yield* new NotLoggedInError({ provider: provider.name });
    }
    const now = yield* Clock.currentTimeMillis;
    if (saved.expiresAt.getTime() <= now) {
      return yield* new LoginExpiredError({ provider: provider.name });
    }
    const expiresAt = new Date(now + Duration.toMillis(span));
    const token = yield* makeToken(saved.session, { name, expiresAt });
    const output = yield* CliOutput;
    yield* output.out(`${Redacted.value(token)}\n`);
    yield* output.err(
      `Made ${provider.name} token "${name}". It is shown only this once: store it now.\n`,
    );
  },
);

// One Provider's login as `auth status` reports it. An `ok` login names
// its account and expiry when both are known, and otherwise only the
// token's end, as the plain line does.
type LoginStatus =
  | { readonly login: "not-needed" | "none" }
  | { readonly login: "rejected"; readonly from: "env"; readonly env: string }
  | {
      readonly login: "expired";
      readonly from: "saved";
      readonly expires: Date;
    }
  | ({
      readonly login: "ok";
      readonly region: string | undefined;
    } & (
      | { readonly from: "saved" }
      | { readonly from: "env"; readonly env: string }
    ) &
      (
        | { readonly account: string; readonly expires: Date }
        | { readonly tokenEnd: string }
      ));

const statusLine = (provider: string, status: LoginStatus) => {
  switch (status.login) {
    case "not-needed":
      return "no login needed";
    case "none":
      return "not logged in";
    case "rejected":
      return `${status.env} is set, but ${provider} did not accept it`;
    case "expired":
      return `expired ${formatTime(status.expires)}. Run: proofbox auth login ${provider}`;
    case "ok": {
      const region =
        status.region === undefined ? "" : `, region ${status.region}`;
      const from =
        status.from === "env" ? `env token ${status.env}` : "saved login";
      return "account" in status
        ? `logged in as ${status.account}${region}, expires ${formatTime(status.expires)}, ${from}`
        : `logged in with token …${status.tokenEnd}${region}, expiry not known, ${from}`;
    }
  }
};

// JSON.stringify leaves out the keys whose value is undefined.
const statusJson = (provider: string, status: LoginStatus) => ({
  provider,
  login: status.login,
  from: "from" in status ? status.from : undefined,
  account: "account" in status ? status.account : undefined,
  region: "region" in status ? status.region : undefined,
  expires: "expires" in status ? formatTime(status.expires) : undefined,
  env: "env" in status ? status.env : undefined,
  tokenEnd: "tokenEnd" in status ? status.tokenEnd : undefined,
});

export const showAuthStatus = Effect.fn("auth.showAuthStatus")(
  function* (options: { readonly json: boolean }) {
    const providers = yield* Providers;
    const logins = yield* Effect.cached(readLogins);
    const output = yield* CliOutput;
    const now = yield* Clock.currentTimeMillis;
    // The JSON needs every Provider first; a plain line goes out as soon
    // as its Provider is checked, so a later failure keeps it.
    const items: ReturnType<typeof statusJson>[] = [];
    for (const entry of providers.values()) {
      const provider = yield* entry.load;
      const part = provider.login;
      let status: LoginStatus;
      if (part._tag === "None") {
        status = { login: "not-needed" };
      } else {
        // A regional Provider names the login's region, or its fallback
        // when the login carries none.
        const regions = provider.regions;
        const regionOf = (region: Option.Option<string>) =>
          regions === undefined
            ? undefined
            : Option.getOrElse(region, () => regions.fallback);
        const env = yield* envToken(provider.name);
        if (Option.isSome(env)) {
          const name = envTokenName(provider.name);
          const envRegionName = yield* envRegion(provider.name);
          const region = regionOf(envRegionName);
          status = yield* part.checkToken(env.value, envRegionName).pipe(
            Effect.map(
              (account): LoginStatus =>
                account.account !== undefined && account.expiresAt !== undefined
                  ? {
                      login: "ok",
                      from: "env",
                      env: name,
                      region,
                      account: account.account,
                      expires: account.expiresAt,
                    }
                  : {
                      login: "ok",
                      from: "env",
                      env: name,
                      region,
                      tokenEnd: Redacted.value(env.value).slice(-4),
                    },
            ),
            Effect.catchTag("TokenRejectedError", () =>
              Effect.succeed<LoginStatus>({
                login: "rejected",
                from: "env",
                env: name,
              }),
            ),
          );
        } else {
          // A logins file that cannot be read counts as no saved login.
          const saved = (yield* logins.pipe(
            Effect.catchAll(() =>
              Effect.succeed<Record<string, SavedLogin>>({}),
            ),
          ))[provider.name];
          if (saved === undefined) {
            status = { login: "none" };
          } else if (
            saved.expiresAt !== undefined &&
            saved.expiresAt.getTime() <= now
          ) {
            status = {
              login: "expired",
              from: "saved",
              expires: saved.expiresAt,
            };
          } else {
            const region = regionOf(Option.fromNullable(saved.region));
            if (saved.way === "browser") {
              status = {
                login: "ok",
                from: "saved",
                region,
                account: saved.account,
                expires: saved.expiresAt,
              };
            } else if (
              saved.account !== undefined &&
              saved.expiresAt !== undefined
            ) {
              status = {
                login: "ok",
                from: "saved",
                region,
                account: saved.account,
                expires: saved.expiresAt,
              };
            } else {
              status = {
                login: "ok",
                from: "saved",
                region,
                tokenEnd: Redacted.value(saved.token).slice(-4),
              };
            }
          }
        }
      }
      if (options.json) {
        items.push(statusJson(provider.name, status));
      } else {
        yield* output.out(
          `${provider.name}  ${statusLine(provider.name, status)}\n`,
        );
      }
    }
    if (options.json) {
      yield* output.out(`${JSON.stringify(items)}\n`);
    }
  },
);

// Logout deletes the Sandboxes this machine started, then removes the
// saved slot (ADR 0016), and says what it did on stderr. The deleted ids
// are the result on stdout.
export const logoutOfProvider = Effect.fn("auth.logoutOfProvider")(function* (
  name: string,
) {
  const { provider } = yield* loginPartFor(name);
  const output = yield* CliOutput;
  const result = yield* logOut(provider, (creates) =>
    output.err(
      creates === 1
        ? "Waiting for 1 create to finish…\n"
        : `Waiting for ${creates} creates to finish…\n`,
    ),
  );
  if (result._tag === "NoLogin") {
    yield* output.err(`No saved login for ${provider.name}.\n`);
    return;
  }
  const { deleted, failures } = result;
  const note =
    deleted.length === 0
      ? ""
      : deleted.length === 1
        ? " Deleted 1 Sandbox."
        : ` Deleted ${deleted.length} Sandboxes.`;
  yield* output.err(`Logged out of ${provider.name}.${note}\n`);
  for (const id of result.elsewhere) {
    yield* output.err(`${id} still runs, started elsewhere.\n`);
  }
  for (const id of result.unfinishedElsewhere) {
    yield* output.err(
      `Unfinished Sandbox ${id}, started elsewhere: it counts against your ${provider.name} quota until it is deleted or its Deadline passes.\n`,
    );
  }
  // Failures last, and each one fails the command.
  for (const failure of failures) {
    yield* output.err(`${failureLine(failure)}\n`);
  }
  if (failures.length > 0) {
    yield* output.setExitCode(125);
  }
  for (const id of deleted) {
    yield* output.out(`${id}\n`);
  }
});

const failureLine = (failure: LogoutFailure) => {
  switch (failure._tag) {
    case "ScanFailed":
      return `Could not check this machine's Sandboxes: ${failure.reason}`;
    case "DeleteFailed":
      return `Could not delete ${failure.id}: ${failure.reason}`;
    case "LoginFilesKept":
      return `Could not remove ${failure.what}: ${failure.reason}`;
    case "Unchecked":
      return `Could not check ${failure.where}: ${failure.reason}`;
  }
};
