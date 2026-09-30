import type { CommandExecutor } from "@effect/platform";
import {
  Context,
  type Duration,
  type Effect,
  type Option,
  type Redacted,
  Schema,
  type Scope,
  type Stream,
} from "effect";
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
  readonly account: string;
  readonly expiresAt: Date;
}

export interface LoginWays {
  readonly _tag: "Ways";
  readonly ways: ReadonlySet<LoginWay>;
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
  NotLoggedInError | LoginExpiredError | BadLoginsFileError
>;

export class SandboxInfo extends Schema.Class<SandboxInfo>("SandboxInfo")({
  name: Schema.String,
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

export type ExecEvent =
  | { readonly _tag: "Stdout"; readonly bytes: Uint8Array }
  | { readonly _tag: "Stderr"; readonly bytes: Uint8Array }
  | { readonly _tag: "Exit"; readonly code: number };

export interface ExecOptions {
  readonly stdin?: Stream.Stream<Uint8Array, ProviderError>;
}

export interface Connection {
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Stream.Stream<ExecEvent, ProviderError | ProviderUnavailableError>;
}

export interface Provider {
  readonly name: string;
  readonly idPrefix: string;
  readonly login: LoginPart;
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
    name: string,
    deadline: Date,
  ) => Effect.Effect<
    void,
    SandboxGoneError | ProviderError | ProviderUnavailableError
  >;
  // Scoped: the Live view stays up until the scope closes. `gone` resolves
  // with a Provider error if the view's link dies while it is open.
  readonly liveView?: (name: string) => Effect.Effect<
    {
      readonly address: string;
      readonly password: string;
      readonly gone: Effect.Effect<
        never,
        SandboxGoneError | ProviderError | ProviderUnavailableError
      >;
    },
    SandboxGoneError | ProviderError | ProviderUnavailableError,
    Scope.Scope
  >;
  // Only where an OS offer has the "snapshot" feature. `save` stores the
  // Sandbox's disk, never its Secrets, under a Fingerprint.
  readonly snapshots?: {
    readonly baseVersion: Effect.Effect<string, ProviderError>;
    readonly save: (
      name: string,
      fingerprint: string,
    ) => Effect.Effect<
      void,
      ProviderError | ProviderUnavailableError | SandboxGoneError,
      Progress
    >;
  };
  readonly get: (
    name: string,
  ) => Effect.Effect<
    SandboxInfo,
    SandboxGoneError | ProviderError | ProviderUnavailableError
  >;
  readonly list: Effect.Effect<
    ReadonlyArray<SandboxInfo>,
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
    name: string,
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
  readonly stateDir: (name: string) => string;
  readonly secretsDir: (name: string, os: Os) => string;
  readonly connect: (
    name: string,
  ) => Effect.Effect<
    Connection,
    SandboxGoneError | ProviderError | ProviderUnavailableError,
    Scope.Scope | CommandExecutor.CommandExecutor
  >;
  readonly memoryKills: (
    name: string,
  ) => Effect.Effect<
    number,
    SandboxGoneError | ProviderError | ProviderUnavailableError
  >;
}

export class Providers extends Context.Tag("proofbox/Providers")<
  Providers,
  ReadonlyMap<string, Provider>
>() {}

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
