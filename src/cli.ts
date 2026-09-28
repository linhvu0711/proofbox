import { Args, Command, Options } from "@effect/cli";
import { Option } from "effect";
import { clickAt } from "./commands/click.ts";
import { createSandbox } from "./commands/create.ts";
import { deleteSandbox } from "./commands/delete.ts";
import { execInSandbox } from "./commands/exec.ts";
import { listSandboxes } from "./commands/list.ts";
import { takeScreenshot } from "./commands/screenshot.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider"),
    idle: Options.text("idle").pipe(Options.optional),
    maxLife: Options.text("max-life").pipe(Options.optional),
    size: Options.text("size").pipe(Options.optional),
  },
  ({ os, provider, idle, maxLife, size }) =>
    createSandbox({
      os,
      provider,
      idle: Option.getOrUndefined(idle),
      maxLife: Option.getOrUndefined(maxLife),
      size: Option.getOrUndefined(size),
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

const actionOptions = {
  screenshot: Options.text("screenshot").pipe(Options.optional),
};

const click = Command.make(
  "click",
  {
    id: Args.text({ name: "id" }),
    x: Args.integer({ name: "x" }),
    y: Args.integer({ name: "y" }),
    button: Options.choice("button", ["left", "middle", "right"]).pipe(
      Options.withDefault("left"),
    ),
    ...actionOptions,
  },
  ({ id, x, y, button, screenshot }) =>
    clickAt({
      id,
      x,
      y,
      button,
      screenshot: Option.getOrUndefined(screenshot),
    }),
);

const screenshot = Command.make(
  "screenshot",
  {
    id: Args.text({ name: "id" }),
    out: Options.text("out"),
  },
  ({ id, out }) => takeScreenshot(id, out),
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

const command = Command.make("proofbox").pipe(
  Command.withSubcommands([create, exec, screenshot, click, list, del]),
);

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
