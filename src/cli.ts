import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { Effect, HashMap, Option, Schema } from "effect";
import {
  loginToProvider,
  logoutOfProvider,
  makeRobotToken,
  showAuthStatus,
} from "./commands/auth.ts";
import { clickAt } from "./commands/click.ts";
import { createSandbox } from "./commands/create.ts";
import { deleteSandbox } from "./commands/delete.ts";
import { dragFrom } from "./commands/drag.ts";
import { execInSandbox } from "./commands/exec.ts";
import { pressKey } from "./commands/key.ts";
import { listSandboxes } from "./commands/list.ts";
import { openLive } from "./commands/live.ts";
import { setMark } from "./commands/mark.ts";
import { startRecording, stopRecording } from "./commands/record.ts";
import { takeScreenshot } from "./commands/screenshot.ts";
import { scrollAt } from "./commands/scroll.ts";
import { typeText } from "./commands/type.ts";
import { uploadWorkFolder } from "./commands/upload.ts";
import { parseMaxSize } from "./upload/max-size.ts";

const create = Command.make(
  "create",
  {
    os: Options.choice("os", ["linux", "macos"]),
    provider: Options.text("provider").pipe(Options.optional),
    idle: Options.text("idle").pipe(Options.optional),
    maxLife: Options.text("max-life").pipe(Options.optional),
    work: Options.text("work").pipe(Options.optional),
    setup: Options.text("setup").pipe(Options.optional),
    envFile: Options.text("env-file").pipe(Options.optional),
    maxSize: Options.text("max-size").pipe(Options.optional),
    size: Options.text("size").pipe(Options.optional),
  },
  ({ os, provider, idle, maxLife, work, setup, envFile, maxSize, size }) =>
    createSandbox({
      os,
      provider: Option.getOrUndefined(provider),
      idle: Option.getOrUndefined(idle),
      maxLife: Option.getOrUndefined(maxLife),
      work: Option.getOrUndefined(work),
      setup: Option.getOrUndefined(setup),
      envFile: Option.getOrUndefined(envFile),
      maxSize: Option.getOrUndefined(maxSize),
      size: Option.getOrUndefined(size),
    }),
);

const exec = Command.make(
  "exec",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("a Sandbox id, for example ns:us:abc123"),
    ),
    command: Args.text({ name: "command" }).pipe(Args.atLeast(1)),
  },
  ({ id, command }) => execInSandbox(id, command),
);

const actionOptions = {
  screenshot: Options.text("screenshot").pipe(Options.optional),
  pace: Options.choice("pace", ["human", "fast"]).pipe(
    Options.withDefault("human" as const),
  ),
};

const glide = Options.text("glide").pipe(Options.optional);
const letter = Options.text("letter").pipe(Options.optional);
const typeMax = Options.text("type-max").pipe(Options.optional);
const settle = Options.text("settle").pipe(Options.optional);

// @effect/cli gives unknown flags to optional [steps]; use its unknown-argument line.
// The schema is the one Args.integer uses.
const scrollSteps = Args.text({ name: "steps" }).pipe(
  Args.withDescription("An integer, 3 by default."),
  Args.mapEffect((value) =>
    Schema.decodeUnknown(Schema.compose(Schema.NumberFromString, Schema.Int))(
      value,
    ).pipe(
      Effect.mapError(() =>
        HelpDoc.p(
          value.startsWith("-")
            ? `Received unknown argument: '${value}'`
            : `'${value}' is not a integer`,
        ),
      ),
    ),
  ),
  Args.withDefault(3),
);

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
    glide,
    settle,
  },
  ({ id, x, y, button, screenshot, pace, glide, settle }) =>
    clickAt({
      id,
      x,
      y,
      button,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
      settle: Option.getOrUndefined(settle),
    }),
);

const type = Command.make(
  "type",
  {
    id: Args.text({ name: "id" }),
    text: Args.text({ name: "text" }),
    ...actionOptions,
    letter,
    typeMax,
    settle,
  },
  ({ id, text, screenshot, pace, letter, typeMax, settle }) =>
    typeText({
      id,
      text,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
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
    settle,
  },
  ({ id, keys, screenshot, pace, settle }) =>
    pressKey({
      id,
      keys,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
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
    steps: scrollSteps,
    ...actionOptions,
    glide,
    settle,
  },
  ({ id, x, y, direction, steps, screenshot, pace, glide, settle }) =>
    scrollAt({
      id,
      x,
      y,
      direction,
      steps,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
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
    glide,
    settle,
  },
  ({ id, x1, y1, x2, y2, screenshot, pace, glide, settle }) =>
    dragFrom({
      id,
      x1,
      y1,
      x2,
      y2,
      screenshot: Option.getOrUndefined(screenshot),
      pace,
      glide: Option.getOrUndefined(glide),
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

// One `--json` for every command whose stdout has more than one field.
const json = Options.boolean("json").pipe(
  Options.withDescription("print JSON for scripts"),
);

const list = Command.make("list", { json }, ({ json }) =>
  listSandboxes({ json }),
);

const del = Command.make(
  "delete",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("a Sandbox id, for example ns:us:abc123"),
    ),
  },
  ({ id }) => deleteSandbox(id),
);

const mark = Command.make(
  "mark",
  {
    id: Args.text({ name: "id" }),
    label: Args.text({ name: "label" }),
    wait: Options.boolean("wait"),
  },
  ({ id, label, wait }) => setMark({ id, label, wait }),
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
    out: Options.text("out").pipe(Options.optional),
    discard: Options.boolean("discard"),
    maxSize: Options.text("max-size").pipe(Options.optional),
    json,
  },
  ({ id, out, discard, maxSize, json }) =>
    Effect.gen(function* () {
      const limit = yield* maxSize.pipe(
        Option.map((value) => parseMaxSize(value)),
        Option.getOrElse(() => Effect.succeed(undefined)),
      );
      yield* stopRecording({
        id,
        out: Option.getOrUndefined(out),
        discard,
        maxSize: limit,
        json,
      });
    }),
);

const record = Command.make("record").pipe(
  Command.withSubcommands([recordStart, recordStop]),
);

const authLogin = Command.make(
  "login",
  {
    provider: Args.text({ name: "provider" }),
    token: Options.boolean("token"),
    region: Options.text("region").pipe(Options.optional),
  },
  ({ provider, token, region }) => loginToProvider({ provider, token, region }),
);

const authStatus = Command.make("status", { json }, ({ json }) =>
  showAuthStatus({ json }),
);

const authLogout = Command.make(
  "logout",
  {
    provider: Args.text({ name: "provider" }),
  },
  ({ provider }) => logoutOfProvider(provider),
);

const authToken = Command.make(
  "token",
  {
    provider: Args.text({ name: "provider" }),
    name: Options.text("name").pipe(Options.optional),
    expires: Options.text("expires").pipe(Options.optional),
  },
  ({ provider, name, expires }) => makeRobotToken({ provider, name, expires }),
);

const auth = Command.make("auth").pipe(
  Command.withSubcommands([authLogin, authStatus, authLogout, authToken]),
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
        Option.map((value) => parseMaxSize(value)),
        Option.getOrElse(() => Effect.succeed(undefined)),
      );
      yield* uploadWorkFolder({ id, folder, maxSize: limit });
    }),
);

const live = Command.make(
  "live",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("a Sandbox id, for example ns:us:abc123"),
    ),
    json,
  },
  ({ id, json }) => openLive(id, { json }),
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
    live,
    record,
    mark,
    auth,
  ]),
);

export const commandWords = (args: ReadonlyArray<string>): string => {
  const first = args[0];
  if (
    first === undefined ||
    !HashMap.has(Command.getSubcommands(command), first)
  )
    return "";
  const groups = new Map([
    ["auth", Command.getSubcommands(auth)],
    ["record", Command.getSubcommands(record)],
  ]);
  const group = groups.get(first);
  const second = args[1];
  return group !== undefined &&
    second !== undefined &&
    HashMap.has(group, second)
    ? `${first} ${second}`
    : first;
};

export const cli = Command.run(command, {
  name: "proofbox",
  version: "0.0.0",
});
