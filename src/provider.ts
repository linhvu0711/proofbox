import { Context, type Effect, Schema } from "effect";
import type { ProviderError } from "./errors.ts";

export const Os = Schema.Literal("linux", "macos");
export type Os = typeof Os.Type;

export const Capability = Schema.Literal("os:linux", "os:macos");
export type Capability = typeof Capability.Type;

export class SandboxInfo extends Schema.Class<SandboxInfo>("SandboxInfo")({
  name: Schema.String,
  os: Os,
  createdAt: Schema.Date,
}) {}

export interface Provider {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly create: (req: {
    readonly os: Os;
  }) => Effect.Effect<SandboxInfo, ProviderError>;
}

export class Providers extends Context.Tag("proofbox/Providers")<
  Providers,
  ReadonlyMap<string, Provider>
>() {}
