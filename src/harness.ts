import { Context, type Duration, type Effect, type Option } from "effect";
import type { HarnessError } from "./errors.ts";

// What login and status need without loading the Harness. envName is
// the environment variable the Harness reads in the Sandbox.
export interface HarnessLogin {
  readonly envName: string;
  readonly what: "token" | "API key";
  readonly placeholder: "<token>" | "<key>";
  readonly howToMake: string;
  readonly lifetime: Option.Option<Duration.Duration>;
}

export type TurnEnd =
  | {
      readonly _tag: "Done";
      readonly session: string;
      readonly lastMessage: string;
    }
  | {
      readonly _tag: "Failed";
      readonly session: Option.Option<string>;
      readonly kind: "login" | "usage-limit" | "other";
      readonly message: string;
      readonly resetsAt: Option.Option<Date>;
    }
  | { readonly _tag: "NoEnd" };

export interface Harness {
  readonly name: string;
  // One shell command run as the Sandbox user; none installs the newest version.
  readonly install: (version: Option.Option<string>) => string;
  // Relative to the Sandbox user's home; instructionsFile sits inside it.
  readonly home: string;
  readonly instructionsFile: string;
  // The argv of a headless Turn, resuming session when given.
  readonly turn: (request: {
    readonly prompt: string;
    readonly model: Option.Option<string>;
    readonly session: Option.Option<string>;
  }) => ReadonlyArray<string>;
  // Reads the whole JSON output, one event per line.
  readonly readEnd: (output: string) => TurnEnd;
}

export interface HarnessEntry {
  readonly name: string;
  readonly login: HarnessLogin;
  readonly load: Effect.Effect<Harness, HarnessError>;
}

export class Harnesses extends Context.Tag("proofbox/Harnesses")<
  Harnesses,
  ReadonlyMap<string, HarnessEntry>
>() {}
