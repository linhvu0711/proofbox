import type { CommandExecutor } from "@effect/platform";
import { Context, type Duration, type Effect, type Option } from "effect";
import type { CliOutput } from "./cli-output.ts";
import type { HarnessError, HarnessLoginError } from "./errors.ts";

export type HarnessLogin = HarnessEnvLogin | HarnessFileLogin;

export interface HarnessEnvLogin {
  readonly _tag: "Env";
  readonly envName: string;
  readonly what: "token";
  readonly placeholder: "<token>";
  readonly howToMake: string;
  readonly lifetime: Option.Option<Duration.Duration>;
}

export interface HarnessFileLogin {
  readonly _tag: "File";
  readonly what: string;
  readonly file: string;
  readonly howToMake: string;
  readonly renewAfter: Duration.Duration;
  readonly load: Effect.Effect<FileLoginTool, HarnessError>;
}

export interface FileLoginTool {
  readonly login: (
    home: string,
  ) => Effect.Effect<
    void,
    HarnessLoginError,
    CommandExecutor.CommandExecutor | CliOutput
  >;
  readonly renew: (
    home: string,
  ) => Effect.Effect<void, HarnessLoginError, CommandExecutor.CommandExecutor>;
  readonly renewedAt: (text: string) => Option.Option<Date>;
  readonly accountOf: (text: string) => Option.Option<string>;
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
      readonly resets: Option.Option<string>;
    }
  | { readonly _tag: "NoEnd" };

// said: a message; tool: a tool call and its main input; result: what a tool
// gave back; other: anything else worth a line. text is whole; stepLine cuts it.
export interface HarnessStep {
  readonly kind: "said" | "tool" | "result" | "other";
  readonly text: string;
}

const byteSize = (bytes: number): string =>
  bytes < 1000
    ? `${bytes} B`
    : bytes < 1_000_000
      ? `${(bytes / 1000).toFixed(1)} KB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;

export const stepLine = (text: string): string => {
  const line = text.split(/\r?\n/)[0] ?? "";
  return line === text && line.length <= 120
    ? line
    : `${line.slice(0, 119)}… (${byteSize(Buffer.byteLength(text, "utf8"))})`;
};

export interface Harness {
  readonly name: string;
  // One shell command run as the Sandbox user; none installs the newest version.
  readonly install: (version: Option.Option<string>) => string;
  // Relative to the Sandbox user's home; instructionsFile sits inside it.
  readonly home: string;
  // What the install and Harness write beside home; git ignores them.
  readonly homeEntries: ReadonlyArray<string>;
  readonly instructionsFile: string;
  // The argv of a headless Turn, resuming session when given.
  readonly turn: (request: {
    readonly prompt: string;
    readonly model: Option.Option<string>;
    readonly session: Option.Option<string>;
  }) => ReadonlyArray<string>;
  // Reads the first line and the last 50 lines of the JSON output, one event per line.
  readonly readEnd: (output: string) => TurnEnd;
  // One line of the Harness's JSON output as its steps, in order; none when the line holds no step.
  readonly readSteps: (event: string) => ReadonlyArray<HarnessStep>;
}

// What profile init copies from the Caller's laptop. home is relative to
// the Caller's HOME; a part that is a folder ends in `/`; leftOut names
// what stays on the laptop.
export interface HarnessProfile {
  readonly home: string;
  readonly parts: ReadonlyArray<string>;
  readonly leftOut: string;
}

export interface HarnessEntry {
  readonly name: string;
  readonly login: HarnessLogin;
  readonly profile: HarnessProfile;
  readonly load: Effect.Effect<Harness, HarnessError>;
}

export class Harnesses extends Context.Tag("proofbox/Harnesses")<
  Harnesses,
  ReadonlyMap<string, HarnessEntry>
>() {}
