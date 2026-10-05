import type { CommandExecutor } from "@effect/platform";
import {
  Context,
  type Duration,
  Effect,
  type Option,
  type Redacted,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type { Transport } from "./command-checks.ts";
import {
  type BadLoginsFileError,
  type LoginExpiredError,
  type MacPrepareError,
  MissingCapabilityError,
  type NotLoggedInError,
  type ProviderError,
  type ProviderLimitError,
  type ProviderUnavailableError,
  type SandboxGoneError,
  type TokenDeniedError,
  type TokenExposedError,
  type TokenPermissionError,
  type TokenRejectedError,
  type ToolBundleHashError,
  type UnknownRegionError,
} from "./errors.ts";
import type { Progress } from "./progress.ts";
import { Size } from "./size.ts";

export const Os = Schema.Literal("linux", "macos");
export type Os = typeof Os.Type;

export const IdleSeconds = Schema.Number.pipe(Schema.int(), Schema.positive());

export const Feature = Schema.Literal(
  "desktop",
  "recording",
  "live-view",
  "secrets",
  "snapshot",
);
export type Feature = typeof Feature.Type;

// What a Provider gives on one OS: the sizes it makes and the features its
// Sandboxes have there.
export interface OsOffer {
  readonly sizes: "any" | ReadonlyArray<Size>;
  readonly features: ReadonlySet<Feature>;
}

export const LoginWay = Schema.Literal("browser", "token");
export type LoginWay = typeof LoginWay.Type;

export interface ProviderAccount {
  readonly account?: string;
  readonly expiresAt?: Date;
}

// What `auth token` asks the Provider's token-maker for: the token's
// name and when it ends.
export interface TokenRequest {
  readonly name: string;
  readonly expiresAt: Date;
}

// A Provider with a browser login: `start` opens the wait and names the
// login page's URL, `complete` holds until the page was clicked and
// hands the Provider login it made. A Provider that can mint CI tokens
// from the saved login's session names `makeToken`.
export interface BrowserWay {
  readonly start: Effect.Effect<
    { readonly loginId: string; readonly url: string },
    ProviderUnavailableError | ProviderError
  >;
  readonly complete: (loginId: string) => Effect.Effect<
    {
      readonly session: Redacted.Redacted<string>;
      readonly account: string;
      readonly expiresAt: Date;
    },
    ProviderUnavailableError | ProviderError
  >;
  readonly makeToken?: (
    session: Redacted.Redacted<string>,
    request: TokenRequest,
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    | LoginExpiredError
    | TokenDeniedError
    | ProviderUnavailableError
    | ProviderError
  >;
}

export interface LoginWays {
  readonly _tag: "Ways";
  readonly browser?: BrowserWay;
  readonly checkToken: (
    token: Redacted.Redacted<string>,
    region: Option.Option<string>,
  ) => Effect.Effect<
    ProviderAccount,
    TokenRejectedError | TokenPermissionError | ProviderUnavailableError
  >;
}

// What a Provider offers `proofbox auth`: no login at all, or its own
// login ways.
export type LoginPart = { readonly _tag: "None" } | LoginWays;

// The token and region a command uses to act for a Provider account, from
// the env or the saved login.
export interface LoginInHand {
  readonly token: Redacted.Redacted<string>;
  readonly region: Option.Option<string>;
}

export type ProviderLogin = Effect.Effect<
  LoginInHand,
  | NotLoggedInError
  | LoginExpiredError
  | BadLoginsFileError
  | ProviderUnavailableError
  | ProviderError
>;

// What a Provider's calls name a Sandbox with: its name and, on a Provider
// with regions, the region it lives in.
export interface SandboxRef {
  readonly name: string;
  readonly region: string | undefined;
}

export class SandboxInfo extends Schema.Class<SandboxInfo>("SandboxInfo")({
  name: Schema.String,
  region: Schema.optional(Schema.String),
  os: Os,
  createdAt: Schema.Date,
  idleSeconds: IdleSeconds,
  deadline: Schema.Date,
  maxLifeAt: Schema.Date,
  base: Schema.optional(Schema.String),
  // The Fingerprint of the Snapshot the Sandbox started from.
  snapshot: Schema.optional(Schema.String),
  size: Schema.optional(Size),
}) {}

// The Sandbox's memory-kill count read just before and just after one
// command, in the same remote call as the command.
export interface MemoryKills {
  readonly before: number;
  readonly after: number;
}

export type ExecEvent =
  | { readonly _tag: "Stdout"; readonly bytes: Uint8Array }
  | { readonly _tag: "Stderr"; readonly bytes: Uint8Array }
  | {
      readonly _tag: "Exit";
      readonly code: number;
      readonly kills?: MemoryKills;
    };

export interface ExecOptions {
  readonly stdin?: Stream.Stream<Uint8Array, ProviderError>;
}

// What a read or a Deadline push of one Sandbox can fail with.
export type SandboxCallError =
  | BadLoginsFileError
  | LoginExpiredError
  | NotLoggedInError
  | SandboxGoneError
  | ProviderError
  | ProviderLimitError
  | ProviderUnavailableError
  | TokenRejectedError
  | TokenPermissionError;

// A Sandbox reached over one link. It runs commands through a transport
// that the command run drives (ADR 0015).
export interface Connection {
  // The Sandbox as `connect` read it.
  readonly info: SandboxInfo;
  // Reads the Sandbox again over this connection: the Keeper's gone-watch.
  readonly get: Effect.Effect<SandboxInfo, SandboxCallError>;
  // One Deadline push over this connection, with no command.
  readonly extend: (deadline: Date) => Effect.Effect<void, SandboxCallError>;
  // How each command reaches the Sandbox.
  readonly transport: Transport;
}

// The folders a Provider keeps proofbox's own files in; the file names
// live in `src/sandbox-file.ts`.
export interface SandboxFolders {
  readonly state: string;
  readonly secrets: string;
}

// Files a saved login leaves in the runtime dir, by name; `what` names
// them when they cannot be removed.
export interface LoginFiles {
  readonly what: string;
  readonly names: RegExp;
}

export interface Provider {
  readonly name: string;
  readonly idPrefix: string;
  readonly login: LoginPart;
  // The files a saved login leaves in the runtime dir; logout removes them
  // with the login.
  readonly loginFiles: ReadonlyArray<LoginFiles>;
  // A Provider whose API is regional names the regions it knows and the
  // one new Sandboxes go to when the login has none.
  readonly regions?: {
    readonly known: ReadonlyArray<string>;
    readonly fallback: string;
  };
  readonly offers: Readonly<Partial<Record<Os, OsOffer>>>;
  readonly create: (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    // Providers whose Max life clock starts before the Sandbox exists (the
    // host is created first) pass the absolute Max life here; the default
    // is the Sandbox's own create time plus `maxLife`.
    readonly maxLifeAt?: Date | undefined;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
    // The Fingerprint of a Snapshot to start from, when the Provider has one.
    readonly snapshot?: string | undefined;
  }) => Effect.Effect<
    SandboxInfo,
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | ToolBundleHashError
    | TokenExposedError
    | MacPrepareError
    | NotLoggedInError
    | LoginExpiredError
    | BadLoginsFileError
    | TokenRejectedError
    | TokenPermissionError
    | UnknownRegionError,
    Progress
  >;
  readonly extend: (
    sandbox: SandboxRef,
    deadline: Date,
  ) => Effect.Effect<
    void,
    | BadLoginsFileError
    | LoginExpiredError
    | NotLoggedInError
    | SandboxGoneError
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | TokenRejectedError
    | TokenPermissionError
  >;
  // Scoped: the Live view stays up until the scope closes. `gone` resolves
  // with a Provider error if the view's link dies while it is open.
  readonly liveView?: (sandbox: SandboxRef) => Effect.Effect<
    {
      readonly address: string;
      readonly password: string;
      readonly gone: Effect.Effect<
        never,
        | BadLoginsFileError
        | LoginExpiredError
        | NotLoggedInError
        | SandboxGoneError
        | ProviderError
        | ProviderUnavailableError
      >;
    },
    | BadLoginsFileError
    | LoginExpiredError
    | NotLoggedInError
    | SandboxGoneError
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | TokenRejectedError
    | TokenPermissionError,
    Scope.Scope
  >;
  // Only where an OS offer has the "snapshot" feature. `save` stores the
  // Sandbox's disk, never its Secrets, under a Fingerprint.
  readonly snapshots?: {
    readonly baseVersion: Effect.Effect<string, ProviderError>;
    readonly save: (
      sandbox: SandboxRef,
      fingerprint: string,
    ) => Effect.Effect<
      void,
      | BadLoginsFileError
      | LoginExpiredError
      | NotLoggedInError
      | ProviderError
      | ProviderLimitError
      | ProviderUnavailableError
      | SandboxGoneError
      | TokenRejectedError
      | TokenPermissionError,
      Progress
    >;
  };
  readonly get: (
    sandbox: SandboxRef,
  ) => Effect.Effect<
    SandboxInfo,
    | BadLoginsFileError
    | LoginExpiredError
    | NotLoggedInError
    | SandboxGoneError
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | TokenRejectedError
    | TokenPermissionError
  >;
  readonly list: Effect.Effect<
    ListResult,
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | TokenRejectedError
    | TokenPermissionError
    | NotLoggedInError
    | LoginExpiredError
    | BadLoginsFileError
  >;
  readonly delete: (
    sandbox: SandboxRef,
  ) => Effect.Effect<
    "deleted" | "gone",
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | SandboxGoneError
    | TokenRejectedError
    | TokenPermissionError
    | NotLoggedInError
    | LoginExpiredError
    | BadLoginsFileError
  >;
  readonly sandboxFolders: (name: string, os: Os) => SandboxFolders;
  readonly connect: (
    sandbox: SandboxRef,
  ) => Effect.Effect<
    Connection,
    | BadLoginsFileError
    | LoginExpiredError
    | NotLoggedInError
    | SandboxGoneError
    | ProviderError
    | ProviderLimitError
    | ProviderUnavailableError
    | TokenRejectedError
    | TokenPermissionError,
    Scope.Scope | CommandExecutor.CommandExecutor
  >;
}

// A machine a create started at the Provider and never made into a
// Sandbox. It has no Deadline of its own to show, only when it started.
export interface UnfinishedSandbox {
  readonly name: string;
  readonly region?: string | undefined;
  readonly os: Os;
  readonly createdAt?: Date | undefined;
}

// What a Provider's list gives: the Sandboxes it reached, each place it
// could not reach — a `list` still shows the Sandboxes it got — and each
// Unfinished Sandbox it saw.
export interface ListResult {
  readonly infos: ReadonlyArray<SandboxInfo>;
  readonly unreached: ReadonlyArray<{
    readonly where: string;
    readonly reason: string;
  }>;
  readonly unfinished: ReadonlyArray<UnfinishedSandbox>;
}

// A Provider the registry knows by name and id prefix. Its code loads the
// first time a command asks for it.
export interface ProviderEntry {
  readonly name: string;
  readonly idPrefix: string;
  readonly load: Effect.Effect<Provider, ProviderError>;
}

// The entry for a Provider that is already built.
export const providerEntry = (provider: Provider): ProviderEntry => ({
  name: provider.name,
  idPrefix: provider.idPrefix,
  load: Effect.succeed(provider),
});

export class Providers extends Context.Tag("proofbox/Providers")<
  Providers,
  ReadonlyMap<string, ProviderEntry>
>() {}

// The Provider's Live view on this OS, when it offers one there.
export const liveViewOn = (provider: Provider, os: Os) =>
  provider.offers[os]?.features.has("live-view") === true
    ? provider.liveView
    : undefined;

// The OS is named only for a Provider with more than one OS, where the
// feature may be there on the other one.
export const lacksFeature = (
  provider: Provider,
  os: Os,
  feature: Feature,
  outcome: string,
) =>
  new MissingCapabilityError({
    provider: provider.name,
    capability: feature,
    os: Object.keys(provider.offers).length > 1 ? os : undefined,
    outcome,
  });
