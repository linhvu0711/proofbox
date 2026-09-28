import { Args, Command, Options } from "@effect/cli";
import { Option } from "effect";
import { createSandbox } from "./commands/create.ts";
import { execInSandbox } from "./commands/exec.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider"),
    idle: Options.text("idle").pipe(Options.optional),
    maxLife: Options.text("max-life").pipe(Options.optional),
  },
  ({ os, provider, idle, maxLife }) =>
    createSandbox({
      os,
      provider,
      idle: Option.getOrUndefined(idle),
      maxLife: Option.getOrUndefined(maxLife),
    }),
);

const exec = Command.make(
  "exec",
  {
    id: Args.text({ name: "id" }),
    command: Args.text({ name: "command" }).pipe(Args.atLeast(1)),
  },
  ({ id, command }) => execInSandbox(id, command),
);

const command = Command.make("proofbox").pipe(
  Command.withSubcommands([create, exec]),
);

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
