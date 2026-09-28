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

export const Os = Schema.Literal("linux", "macos");
export type Os = typeof Os.Type;

export const Capability = Schema.Literal("os:linux", "os:macos");
export type Capability = typeof Capability.Type;

export class SandboxInfo extends Schema.Class<SandboxInfo>("SandboxInfo")({
  name: Schema.String,
  os: Os,
  createdAt: Schema.Date,
  idleSeconds: Schema.Number,
  deadline: Schema.Date,
  maxLifeAt: Schema.Date,
}) {}

export type ExecEvent =
  | { readonly _tag: "Stdout"; readonly bytes: Uint8Array }
  | { readonly _tag: "Stderr"; readonly bytes: Uint8Array }
  | { readonly _tag: "Exit"; readonly code: number };

export interface Connection {
  readonly exec: (
    argv: ReadonlyArray<string>,
  ) => Stream.Stream<ExecEvent, ProviderError>;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly create: (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
  }) => Effect.Effect<SandboxInfo, ProviderError>;
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
