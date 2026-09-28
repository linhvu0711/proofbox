import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { createSandbox } from "./commands/create.ts";
import { deleteSandbox } from "./commands/delete.ts";
import { execInSandbox } from "./commands/exec.ts";
import { listSandboxes } from "./commands/list.ts";
import { uploadWorkFolder } from "./commands/upload.ts";
import { parseMaxSize } from "./upload/max-size.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider"),
    idle: Options.text("idle").pipe(Options.optional),
    maxLife: Options.text("max-life").pipe(Options.optional),
    work: Options.text("work").pipe(Options.optional),
    setup: Options.text("setup").pipe(Options.optional),
    maxSize: Options.text("max-size").pipe(Options.optional),
  },
  ({ os, provider, idle, maxLife, work, setup, maxSize }) =>
    createSandbox({
      os,
      provider,
      idle: Option.getOrUndefined(idle),
      maxLife: Option.getOrUndefined(maxLife),
      work: Option.getOrUndefined(work),
      setup: Option.getOrUndefined(setup),
      maxSize: Option.getOrUndefined(maxSize),
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

const list = Command.make(
  "list",
  { json: Options.boolean("json") },
  ({ json }) => listSandboxes({ json }),
);

const del = Command.make(
  "delete",
  { id: Args.text({ name: "id" }) },
  ({ id }) => deleteSandbox(id),
);

const upload = Command.make(
  "upload",
  {
    id: Args.text({ name: "id" }),
    folder: Args.text({ name: "folder" }),
    maxSize: Options.text("max-size").pipe(Options.optional),
  },
  ({ id, folder, maxSize }) =>
    Effect.gen(function* () {
      const limit = yield* maxSize.pipe(
        Option.map(parseMaxSize),
        Option.getOrElse(() => Effect.succeed(undefined)),
      );
      yield* uploadWorkFolder({ id, folder, maxSize: limit });
    }),
);

const command = Command.make("proofbox").pipe(
  Command.withSubcommands([create, exec, list, del, upload]),
);

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
