import type { CommandExecutor } from "@effect/platform";
import {
  Context,
  type Duration,
  type Effect,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type { ProviderError, SandboxGoneError } from "./errors.ts";
import type { Progress } from "./progress.ts";

export const Os = Schema.Literal("linux", "macos");
export type Os = typeof Os.Type;

export const IdleSeconds = Schema.Number.pipe(Schema.int(), Schema.positive());

export const Capability = Schema.Literal("os:linux", "os:macos");
export type Capability = typeof Capability.Type;

export class SandboxInfo extends Schema.Class<SandboxInfo>("SandboxInfo")({
  name: Schema.String,
  os: Os,
  createdAt: Schema.Date,
  idleSeconds: IdleSeconds,
  deadline: Schema.Date,
  maxLifeAt: Schema.Date,
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
  ) => Stream.Stream<ExecEvent, ProviderError>;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly create: (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
  }) => Effect.Effect<SandboxInfo, ProviderError, Progress>;
  readonly extend: (
    name: string,
    deadline: Date,
  ) => Effect.Effect<SandboxInfo, SandboxGoneError | ProviderError>;
  readonly get: (
    name: string,
  ) => Effect.Effect<SandboxInfo, SandboxGoneError | ProviderError>;
  readonly list: Effect.Effect<ReadonlyArray<SandboxInfo>, ProviderError>;
  readonly delete: (
    name: string,
  ) => Effect.Effect<"deleted" | "gone", ProviderError>;
  readonly stateDir: (name: string) => string;
  readonly connect: (
    name: string,
  ) => Effect.Effect<
    Connection,
    SandboxGoneError | ProviderError,
    Scope.Scope | CommandExecutor.CommandExecutor
  >;
}

export class Providers extends Context.Tag("proofbox/Providers")<
  Providers,
  ReadonlyMap<string, Provider>
>() {}
