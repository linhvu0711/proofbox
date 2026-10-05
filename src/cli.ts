import {
  Args,
  Command,
  type CommandDescriptor,
  HelpDoc,
  Options,
} from "@effect/cli";
import type { Span } from "@effect/cli/HelpDoc/Span";
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
import { KNOWN_REGIONS } from "./namespace/regions.ts";
import { parseMaxSize } from "./upload/max-size.ts";

const sandboxId = Args.text({ name: "id" }).pipe(
  Args.withDescription("a Sandbox id, for example ns:us:abc123"),
);
const workMaxSize = Options.text("max-size").pipe(
  Options.withDescription(
    "the most the Work folder upload may send, MB or GB, for example 800MB; default 500MB",
  ),
  Options.optional,
);

const makeCommands = (providers: ReadonlyArray<string>) => {
  const providerArg = Args.choice(
    providers.map((name): [string, string] => [name, name]),
    { name: "provider" },
  );

  const create = Command.make(
    "create",
    {
      os: Options.choice("os", ["linux", "macos"]).pipe(
        Options.withDescription("the OS of the Sandbox"),
      ),
      provider: Options.choice("provider", providers).pipe(
        Options.withDescription(
          "the Provider that makes the Sandbox; default from ~/.config/proofbox/config, else namespace",
        ),
        Options.optional,
      ),
      idle: Options.text("idle").pipe(
        Options.withDescription(
          "delete the Sandbox after this long with no command, for example 15m; default 15m on Linux, 5m on macOS",
        ),
        Options.optional,
      ),
      maxLife: Options.text("max-life").pipe(
        Options.withDescription(
          "the Max life: delete the Sandbox this long after create, with s, m, or h, for example 2h; default 3h",
        ),
        Options.optional,
      ),
      work: Options.text("work").pipe(
        Options.withDescription(
          "the folder to upload as the Work folder, for example .; default none",
        ),
        Options.optional,
      ),
      setup: Options.text("setup").pipe(
        Options.withDescription(
          "the Setup script to run after the upload, for example setup-linux.sh; needs --work",
        ),
        Options.optional,
      ),
      envFile: Options.text("env-file").pipe(
        Options.withDescription(
          "a file of NAME=VALUE lines to send as Secrets, for example app.env; default none",
        ),
        Options.optional,
      ),
      maxSize: workMaxSize,
      size: Options.text("size").pipe(
        Options.withDescription(
          "the Sandbox size as CPUxRAM_GB, for example 8x16; default 4x8 on Linux, 4x7 on macOS on namespace, no limit on docker",
        ),
        Options.optional,
      ),
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
  ).pipe(Command.withDescription("create a Sandbox and print its Sandbox id"));

  const authLogin = Command.make(
    "login",
    {
      provider: providerArg.pipe(
        Args.withDescription("the Provider to log in to"),
      ),
      token: Options.boolean("token").pipe(
        Options.withDescription(
          "read a token from stdin instead of opening the browser",
        ),
      ),
      region: Options.choice("region", KNOWN_REGIONS).pipe(
        Options.withDescription("where new Sandboxes go; default us"),
        Options.optional,
      ),
    },
    ({ provider, token, region }) =>
      loginToProvider({ provider, token, region }),
  ).pipe(Command.withDescription("log in to a Provider"));

  const authLogout = Command.make(
    "logout",
    {
      provider: providerArg.pipe(
        Args.withDescription("the Provider to log out of"),
      ),
    },
    ({ provider }) => logoutOfProvider(provider),
  ).pipe(
    Command.withDescription(
      "delete this machine's Sandboxes on a Provider, then remove its login",
    ),
  );

  const authToken = Command.make(
    "token",
    {
      provider: providerArg.pipe(
        Args.withDescription("the Provider that makes the token"),
      ),
      name: Options.text("name").pipe(
        Options.withDescription("the token's name, for example ci; required"),
        Options.optional,
      ),
      expires: Options.text("expires").pipe(
        Options.withDescription(
          "when the token ends, with h, d, or y, at most 1y, for example 30d; required",
        ),
        Options.optional,
      ),
    },
    ({ provider, name, expires }) =>
      makeRobotToken({ provider, name, expires }),
  ).pipe(
    Command.withDescription(
      "make a token for CI from the browser login and print it once",
    ),
  );

  const auth = Command.make("auth").pipe(
    Command.withDescription("log in to Providers and manage their logins"),
    Command.withSubcommands([authLogin, authStatus, authLogout, authToken]),
  );

  const command = Command.make("proofbox").pipe(
    Command.withDescription(
      "rent a disposable Sandbox, drive its screen, and bring back a Proof video",
    ),
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
  return { command, auth };
};

export const makeCommand = (providers: ReadonlyArray<string>) =>
  makeCommands(providers).command;

const exec = Command.make(
  "exec",
  {
    id: sandboxId,
    command: Args.text({ name: "command" }).pipe(
      Args.withDescription(
        "the command and its arguments after --, for example -- npm test",
      ),
      Args.atLeast(1),
    ),
  },
  ({ id, command }) => execInSandbox(id, command),
).pipe(
  Command.withDescription(
    "run a command in a Sandbox and pass its exit code through",
  ),
);

const actionOptions = {
  screenshot: Options.text("screenshot").pipe(
    Options.withDescription(
      "save the screen after the action to this PNG file, for example after.png; default none",
    ),
    Options.optional,
  ),
  pace: Options.choice("pace", ["human", "fast"]).pipe(
    Options.withDefault("human" as const),
    Options.withDescription(
      "how fast the action moves: human like a person, fast at once; default human",
    ),
  ),
};

const glide = Options.text("glide").pipe(
  Options.withDescription(
    "how long the pointer takes to move, ms or s, for example 200ms; default 400ms with --pace human, 0ms with fast",
  ),
  Options.optional,
);
const letter = Options.text("letter").pipe(
  Options.withDescription(
    "the wait between letters, ms or s, for example 40ms; default 80ms with --pace human, 12ms with fast",
  ),
  Options.optional,
);
const typeMax = Options.text("type-max").pipe(
  Options.withDescription(
    "the most time all the typing may take, ms or s, for example 5s; default 3000ms",
  ),
  Options.optional,
);
const settle = Options.text("settle").pipe(
  Options.withDescription(
    "the wait after the action, ms or s, for example 1s; default 700ms with --pace human, 0ms with fast",
  ),
  Options.optional,
);

// @effect/cli gives unknown flags to optional [steps]; use its unknown-argument line.
// The schema is the one Args.integer uses.
const scrollSteps = Args.text({ name: "steps" }).pipe(
  Args.withDescription(
    "how many wheel steps, a whole number, for example 5; default 3",
  ),
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
    id: sandboxId,
    x: Args.integer({ name: "x" }).pipe(
      Args.withDescription(
        "pixels from the left edge, as in a screenshot, for example 640",
      ),
    ),
    y: Args.integer({ name: "y" }).pipe(
      Args.withDescription(
        "pixels from the top edge, as in a screenshot, for example 360",
      ),
    ),
    button: Options.choice("button", ["left", "middle", "right"]).pipe(
      Options.withDefault("left"),
      Options.withDescription("the mouse button; default left"),
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
).pipe(Command.withDescription("click at a spot on the Sandbox screen"));

const type = Command.make(
  "type",
  {
    id: sandboxId,
    text: Args.text({ name: "text" }).pipe(
      Args.withDescription("the text to type, for example Hello"),
    ),
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
).pipe(Command.withDescription("type text on the Sandbox screen"));

const key = Command.make(
  "key",
  {
    id: sandboxId,
    keys: Args.text({ name: "keys" }).pipe(
      Args.withDescription(
        "the keys, with + between keys held together, for example ctrl+s or Return",
      ),
    ),
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
).pipe(Command.withDescription("press keys on the Sandbox screen"));

const scroll = Command.make(
  "scroll",
  {
    id: sandboxId,
    x: Args.integer({ name: "x" }).pipe(
      Args.withDescription(
        "pixels from the left edge, as in a screenshot, for example 640",
      ),
    ),
    y: Args.integer({ name: "y" }).pipe(
      Args.withDescription(
        "pixels from the top edge, as in a screenshot, for example 360",
      ),
    ),
    direction: Args.choice<"up" | "down" | "left" | "right">(
      [
        ["up", "up"],
        ["down", "down"],
        ["left", "left"],
        ["right", "right"],
      ],
      { name: "direction" },
    ).pipe(Args.withDescription("the way to scroll")),
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
).pipe(Command.withDescription("scroll at a spot on the Sandbox screen"));

const drag = Command.make(
  "drag",
  {
    id: sandboxId,
    x1: Args.integer({ name: "x1" }).pipe(
      Args.withDescription(
        "where the drag starts, pixels from the left edge, for example 100",
      ),
    ),
    y1: Args.integer({ name: "y1" }).pipe(
      Args.withDescription(
        "where the drag starts, pixels from the top edge, for example 200",
      ),
    ),
    x2: Args.integer({ name: "x2" }).pipe(
      Args.withDescription(
        "where the drag ends, pixels from the left edge, for example 400",
      ),
    ),
    y2: Args.integer({ name: "y2" }).pipe(
      Args.withDescription(
        "where the drag ends, pixels from the top edge, for example 200",
      ),
    ),
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
).pipe(
  Command.withDescription(
    "drag from one spot on the Sandbox screen to another",
  ),
);

const screenshot = Command.make(
  "screenshot",
  {
    id: sandboxId,
    out: Options.text("out").pipe(
      Options.withDescription(
        "the PNG file to write, for example shot.png; required",
      ),
    ),
  },
  ({ id, out }) => takeScreenshot(id, out),
).pipe(Command.withDescription("save a PNG of the Sandbox screen"));

// One `--json` for every command whose stdout has more than one field.
const json = Options.boolean("json").pipe(
  Options.withDescription("print JSON for scripts"),
);

const list = Command.make("list", { json }, ({ json }) =>
  listSandboxes({ json }),
).pipe(Command.withDescription("list your Sandboxes"));

const del = Command.make(
  "delete",
  {
    id: sandboxId,
  },
  ({ id }) => deleteSandbox(id),
).pipe(Command.withDescription("delete a Sandbox"));

const mark = Command.make(
  "mark",
  {
    id: sandboxId,
    label: Args.text({ name: "label" }).pipe(
      Args.withDescription(
        "the mark's text, 1 to 60 characters, for example step 1: open the app",
      ),
    ),
    wait: Options.boolean("wait").pipe(
      Options.withDescription(
        "make it a Wait mark: the reason for a Still part",
      ),
    ),
  },
  ({ id, label, wait }) => setMark({ id, label, wait }),
).pipe(
  Command.withDescription(
    "set a Step mark, or a Wait mark with --wait, during a Recording",
  ),
);

const recordStart = Command.make("start", { id: sandboxId }, ({ id }) =>
  startRecording(id),
).pipe(Command.withDescription("start a Recording of the Sandbox screen"));

const recordStop = Command.make(
  "stop",
  {
    id: sandboxId,
    out: Options.text("out").pipe(
      Options.withDescription(
        "the Proof video file to write, for example proof.mp4; Proof screenshots go next to it",
      ),
      Options.optional,
    ),
    discard: Options.boolean("discard").pipe(
      Options.withDescription("end the Recording with no Proof video"),
    ),
    maxSize: Options.text("max-size").pipe(
      Options.withDescription(
        "the Size limit for the Proof video, MB or GB, for example 20MB; default 10MB",
      ),
      Options.optional,
    ),
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
).pipe(
  Command.withDescription(
    "end the Recording and download its Proof video, or discard it",
  ),
);

const record = Command.make("record").pipe(
  Command.withDescription("start and stop a Recording of the Sandbox screen"),
  Command.withSubcommands([recordStart, recordStop]),
);

const authStatus = Command.make("status", { json }, ({ json }) =>
  showAuthStatus({ json }),
).pipe(Command.withDescription("show each Provider's login"));

const upload = Command.make(
  "upload",
  {
    id: sandboxId,
    folder: Args.text({ name: "folder" }).pipe(
      Args.withDescription(
        "the folder to send as the Work folder, for example .",
      ),
    ),
    maxSize: workMaxSize,
  },
  ({ id, folder, maxSize }) =>
    Effect.gen(function* () {
      const limit = yield* maxSize.pipe(
        Option.map((value) => parseMaxSize(value)),
        Option.getOrElse(() => Effect.succeed(undefined)),
      );
      yield* uploadWorkFolder({ id, folder, maxSize: limit });
    }),
).pipe(
  Command.withDescription(
    "send the Work folder to a Sandbox again; only changed and new files go",
  ),
);

const live = Command.make(
  "live",
  {
    id: sandboxId,
    json,
  },
  ({ id, json }) => openLive(id, { json }),
).pipe(
  Command.withDescription(
    "print the address and password of a Sandbox's Live view",
  ),
);

export const commandWords = (
  args: ReadonlyArray<string>,
  providers: ReadonlyArray<string>,
): string => {
  const { command, auth } = makeCommands(providers);
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

export type Descriptor = CommandDescriptor.Command<unknown> &
  (
    | (CommandDescriptor.Command<{ name: string }> & {
        readonly _tag: "Standard";
        readonly name: string;
        readonly description: HelpDoc.HelpDoc;
      })
    | { readonly _tag: "Map"; readonly command: Descriptor }
    | {
        readonly _tag: "Subcommands";
        readonly parent: Descriptor;
        readonly children: ReadonlyArray<Descriptor>;
      }
  );

export const spanText = (span: Span): string => {
  switch (span._tag) {
    case "Text":
    case "URI":
      return span.value;
    case "Sequence":
      return spanText(span.left) + spanText(span.right);
    default:
      return spanText(span.value);
  }
};

// @effect/cli has no hook for the top help page, so proofbox prints its own
// list: one row per command, in the order the tree holds them.
export const commandList = <Name extends string, R, E, A>(
  root: Command.Command<Name, R, E, A>,
): string => {
  const standard = (
    d: Descriptor,
  ): Extract<Descriptor, { readonly _tag: "Standard" }> => {
    switch (d._tag) {
      case "Map":
        return standard(d.command);
      case "Subcommands":
        return standard(d.parent);
      case "Standard":
        return d;
    }
  };
  const describe = (d: Descriptor): string => {
    const { description } = standard(d);
    return HelpDoc.isParagraph(description) ? spanText(description.value) : "";
  };
  const rows: Array<{ readonly name: string; readonly description: string }> =
    [];
  const visit = (d: Descriptor, depth: number): void => {
    if (d._tag === "Map") {
      visit(d.command, depth);
      return;
    }
    if (d._tag !== "Subcommands") return;
    for (const child of d.children) {
      rows.push({
        name: `${" ".repeat(2 + 2 * depth)}${standard(child).name}`,
        description: describe(child),
      });
      visit(child, depth + 1);
    }
  };
  // @effect/cli types the descriptor as opaque, hiding nested commands.
  const tree = root.descriptor as Descriptor;
  visit(tree, 0);
  const name = standard(tree).name;
  const width = Math.max(...rows.map((row) => row.name.length));
  return [
    "USAGE",
    "",
    `$ ${name} <command>`,
    "",
    "DESCRIPTION",
    "",
    describe(tree),
    "",
    "COMMANDS",
    "",
    ...rows.map((row) => `${row.name.padEnd(width)}  ${row.description}`),
    "",
    `Run ${name} <command> --help for its options. ${name} --version prints the version.`,
    "",
  ].join("\n");
};

export const makeCli = (providers: ReadonlyArray<string>) =>
  Command.run(makeCommand(providers), {
    name: "proofbox",
    version: "0.0.0",
  });
