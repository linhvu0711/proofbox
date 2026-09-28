import { Args, Command, Options } from "@effect/cli";
import { createSandbox } from "./commands/create.ts";
import { execInSandbox } from "./commands/exec.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider"),
  },
  ({ os, provider }) => createSandbox({ os, provider }),
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
