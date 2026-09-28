import type { CommandExecutor } from "@effect/platform";
import {
  Context,
  type Duration,
  type Effect,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type {
  ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenExposedError,
  ToolBundleHashError,
} from "./errors.ts";
import type { Progress } from "./progress.ts";
import { Size } from "./size.ts";

export const Os = Schema.Literal("linux", "macos");
export type Os = typeof Os.Type;

export const IdleSeconds = Schema.Number.pipe(Schema.int(), Schema.positive());

export const Capability = Schema.Literal(
  "os:linux",
  "os:macos",
  "live-view",
  "desktop",
  "snapshot",
);
export type Capability = typeof Capability.Type;

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
  readonly capabilities: ReadonlySet<Capability>;
  readonly sizes: "any" | ReadonlyArray<Size>;
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
    | TokenExposedError,
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
  // Only with the "snapshot" Capability. `save` stores the Sandbox's
  // disk, never its Secrets, under a Fingerprint.
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
  readonly list: Effect.Effect<ReadonlyArray<SandboxInfo>, ProviderError>;
  readonly delete: (
    name: string,
  ) => Effect.Effect<
    "deleted" | "gone",
    ProviderError | ProviderUnavailableError
  >;
  readonly stateDir: (name: string) => string;
  readonly secretsDir: (name: string) => string;
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
