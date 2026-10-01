import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import {
  Clock,
  Config,
  Duration,
  Effect,
  Either,
  Option,
  Redacted,
} from "effect";
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
import { keeperPaths } from "../keeper/paths.ts";
import {
  changeLogins,
  readLogins,
  type SavedLogin,
} from "../login/logins-file.ts";
import { openBrowser } from "../login/open-browser.ts";
import { envRegion, envToken, envTokenName } from "../login/provider-login.ts";
import { Providers } from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";

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

export const loginToProvider = (options: {
  readonly provider: string;
  readonly token: boolean;
  readonly region: Option.Option<string>;
}) =>
  Effect.gen(function* () {
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
  });

// A CI token for the Provider, minted from the saved browser login and
// printed once on stdout. The env token is never read: it cannot make
// tokens.
export const makeRobotToken = (options: {
  readonly provider: string;
  readonly name: Option.Option<string>;
  readonly expires: Option.Option<string>;
}) =>
  Effect.gen(function* () {
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
          Effect.map((account) =>
            account.account !== undefined && account.expiresAt !== undefined
              ? `logged in as ${account.account}${regionOf(region)}, expires ${formatTime(account.expiresAt)}, env token ${envTokenName(provider.name)}`
              : `logged in with token …${Redacted.value(env.value).slice(-4)}${regionOf(region)}, expiry not known, env token ${envTokenName(provider.name)}`,
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
        } else if (
          saved.expiresAt !== undefined &&
          saved.expiresAt.getTime() <= now
        ) {
          line = `expired ${formatTime(saved.expiresAt)}. Run: proofbox auth login ${provider.name}`;
        } else if (saved.way === "browser") {
          line = `logged in as ${saved.account}${regionOf(Option.fromNullable(saved.region))}, expires ${formatTime(saved.expiresAt)}, saved login`;
        } else if (
          saved.account !== undefined &&
          saved.expiresAt !== undefined
        ) {
          line = `logged in as ${saved.account}${regionOf(Option.fromNullable(saved.region))}, expires ${formatTime(saved.expiresAt)}, saved login`;
        } else {
          line = `logged in with token …${Redacted.value(saved.token).slice(-4)}${regionOf(Option.fromNullable(saved.region))}, expiry not known, saved login`;
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
    if (provider.name === "namespace") {
      // Older versions kept a bearer-token file per token, and the session
      // trade keeps a tenant-token file per session, in the runtime dir;
      // those die with the login.
      const dir = (yield* keeperPaths({ provider: "ns", name: "__probe__" }))
        .dir;
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of await readdir(dir)) {
            if (/^ns-(?:token|tenant)-[0-9a-f]{16}\.json$/.test(file)) {
              await rm(join(dir, file), { force: true });
            }
          }
        },
        catch: (cause) =>
          new ProviderError({
            provider: "namespace",
            reason: String(cause),
          }),
      });
    }
    if (Either.isLeft(listed)) {
      yield* output.err(
        `Logged out of ${provider.name}. Could not check for running Sandboxes. Any left stop at their Deadline.\n`,
      );
      return;
    }
    const infos = listed.right.infos;
    const note =
      infos.length === 0
        ? ""
        : infos.length === 1
          ? " 1 Sandbox still runs. It stops at its Deadline."
          : ` ${infos.length} Sandboxes still run. They stop at their Deadline.`;
    yield* output.err(`Logged out of ${provider.name}.${note}\n`);
    for (const miss of listed.right.unreached) {
      yield* output.err(`Could not check ${miss.where}: ${miss.reason}\n`);
    }
    for (const info of infos) {
      yield* output.out(
        `${formatSandboxId({ provider: provider.idPrefix, region: info.region, name: info.name })}\n`,
      );
    }
  });
