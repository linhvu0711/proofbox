import { Command, Options } from "@effect/cli";
import { createSandbox } from "./commands/create.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider"),
  },
  ({ os, provider }) => createSandbox({ os, provider }),
);

const command = Command.make("proofbox").pipe(
  Command.withSubcommands([create]),
);

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
