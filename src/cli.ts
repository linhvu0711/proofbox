import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { clickAt } from "./commands/click.ts";
import { createSandbox } from "./commands/create.ts";
import { deleteSandbox } from "./commands/delete.ts";
import { dragFrom } from "./commands/drag.ts";
import { execInSandbox } from "./commands/exec.ts";
import { pressKey } from "./commands/key.ts";
import { startRecording, stopRecording } from "./commands/record.ts";
import { listSandboxes } from "./commands/list.ts";
import { takeScreenshot } from "./commands/screenshot.ts";
import { scrollAt } from "./commands/scroll.ts";
import { typeText } from "./commands/type.ts";
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
    size: Options.text("size").pipe(Options.optional),
  },
  ({ os, provider, idle, maxLife, work, setup, maxSize, size }) =>
    createSandbox({
      os,
      provider,
      idle: Option.getOrUndefined(idle),
      maxLife: Option.getOrUndefined(maxLife),
      work: Option.getOrUndefined(work),
      setup: Option.getOrUndefined(setup),
      maxSize: Option.getOrUndefined(maxSize),
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
  pace: Options.choice("pace", ["human", "fast"]).pipe(
    Options.withDefault("human" as const),
  ),
  glide: Options.text("glide").pipe(Options.optional),
  letter: Options.text("letter").pipe(Options.optional),
  typeMax: Options.text("type-max").pipe(Options.optional),
  settle: Options.text("settle").pipe(Options.optional),
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
  ({ id, x, y, button, screenshot, pace, glide, letter, typeMax, settle }) =>
    clickAt({
      id,
      x,
      y,
      button,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      letter: Option.getOrUndefined(letter),
      typeMax: Option.getOrUndefined(typeMax),
      settle: Option.getOrUndefined(settle),
    }),
);

const type = Command.make(
  "type",
  {
    id: Args.text({ name: "id" }),
    text: Args.text({ name: "text" }),
    ...actionOptions,
  },
  ({ id, text, screenshot, pace, glide, letter, typeMax, settle }) =>
    typeText({
      id,
      text,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      letter: Option.getOrUndefined(letter),
      typeMax: Option.getOrUndefined(typeMax),
      settle: Option.getOrUndefined(settle),
    }),
);

const key = Command.make(
  "key",
  {
    id: Args.text({ name: "id" }),
    keys: Args.text({ name: "keys" }),
    ...actionOptions,
  },
  ({ id, keys, screenshot, pace, glide, letter, typeMax, settle }) =>
    pressKey({
      id,
      keys,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      letter: Option.getOrUndefined(letter),
      typeMax: Option.getOrUndefined(typeMax),
      settle: Option.getOrUndefined(settle),
    }),
);

const scroll = Command.make(
  "scroll",
  {
    id: Args.text({ name: "id" }),
    x: Args.integer({ name: "x" }),
    y: Args.integer({ name: "y" }),
    direction: Args.choice<"up" | "down" | "left" | "right">(
      [
        ["up", "up"],
        ["down", "down"],
        ["left", "left"],
        ["right", "right"],
      ],
      { name: "direction" },
    ),
    steps: Args.integer({ name: "steps" }).pipe(Args.withDefault(3)),
    ...actionOptions,
  },
  ({
    id,
    x,
    y,
    direction,
    steps,
    screenshot,
    pace,
    glide,
    letter,
    typeMax,
    settle,
  }) =>
    scrollAt({
      id,
      x,
      y,
      direction,
      steps,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      letter: Option.getOrUndefined(letter),
      typeMax: Option.getOrUndefined(typeMax),
      settle: Option.getOrUndefined(settle),
    }),
);

const drag = Command.make(
  "drag",
  {
    id: Args.text({ name: "id" }),
    x1: Args.integer({ name: "x1" }),
    y1: Args.integer({ name: "y1" }),
    x2: Args.integer({ name: "x2" }),
    y2: Args.integer({ name: "y2" }),
    ...actionOptions,
  },
  ({ id, x1, y1, x2, y2, screenshot, pace, glide, letter, typeMax, settle }) =>
    dragFrom({
      id,
      x1,
      y1,
      x2,
      y2,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      letter: Option.getOrUndefined(letter),
      typeMax: Option.getOrUndefined(typeMax),
      settle: Option.getOrUndefined(settle),
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

const recordStart = Command.make(
  "start",
  { id: Args.text({ name: "id" }) },
  ({ id }) => startRecording(id),
);

const recordStop = Command.make(
  "stop",
  {
    id: Args.text({ name: "id" }),
    out: Options.text("out"),
  },
  ({ id, out }) => stopRecording({ id, out }),
);

const record = Command.make("record").pipe(
  Command.withSubcommands([recordStart, recordStop]),
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
  Command.withSubcommands([
    create,
    exec,
    screenshot,
    click,
    type,
    key,
    scroll,
    drag,
    list,
    del,
    upload,
    record,
  ]),
);

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
