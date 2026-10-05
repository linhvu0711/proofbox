import { Args, CliConfig, Command, HelpDoc, Options } from "@effect/cli";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type Descriptor, makeCommand, spanText } from "../src/cli.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const shortList = `USAGE

$ proofbox <command>

DESCRIPTION

rent a disposable Sandbox, drive its screen, and bring back a Proof video

COMMANDS

  create      create a Sandbox and print its Sandbox id
  exec        run a command in a Sandbox and pass its exit code through
  screenshot  save a PNG of the Sandbox screen
  click       click at a spot on the Sandbox screen
  type        type text on the Sandbox screen
  key         press keys on the Sandbox screen
  scroll      scroll at a spot on the Sandbox screen
  drag        drag from one spot on the Sandbox screen to another
  list        list your Sandboxes
  delete      delete a Sandbox
  upload      send the Work folder to a Sandbox again; only changed and new files go
  live        print the address and password of a Sandbox's Live view
  record      start and stop a Recording of the Sandbox screen
    start     start a Recording of the Sandbox screen
    stop      end the Recording and download its Proof video, or discard it
  mark        set a Step mark, or a Wait mark with --wait, during a Recording
  auth        log in to Providers and manage their logins
    login     log in to a Provider
    status    show each Provider's login
    logout    delete this machine's Sandboxes on a Provider, then remove its login
    token     make a token for CI from the browser login and print it once

Run proofbox <command> --help for its options. proofbox --version prints the version.
`;

const blocks = (doc: HelpDoc.HelpDoc): ReadonlyArray<HelpDoc.HelpDoc> =>
  doc._tag === "Sequence" ? [...blocks(doc.left), ...blocks(doc.right)] : [doc];

const undescribed = <Name extends string, R, E, A>(
  root: Command.Command<Name, R, E, A>,
): string[] => {
  const missing: string[] = [];
  const visit = (
    d: Descriptor,
    parents: ReadonlyArray<string>,
  ): ReadonlyArray<string> => {
    switch (d._tag) {
      case "Map":
        return visit(d.command, parents);
      case "Subcommands": {
        const path = visit(d.parent, parents);
        for (const child of d.children) visit(child, path);
        return path;
      }
      case "Standard": {
        const path = [...parents, d.name];
        const help = blocks(
          Command.getHelp(
            Command.fromDescriptor(d),
            CliConfig.make({ showBuiltIns: false }),
          ),
        );
        if (
          !help.some(
            (block) =>
              block._tag === "Header" &&
              spanText(block.value) === "DESCRIPTION",
          )
        ) {
          missing.push(`${path.join(" ")} (command)`);
        }
        let section = "";
        for (const block of help) {
          if (block._tag === "Header") section = spanText(block.value);
          if (
            block._tag !== "DescriptionList" ||
            (section !== "ARGUMENTS" && section !== "OPTIONS")
          )
            continue;
          for (const [span, body] of block.definitions) {
            const paragraphs = blocks(body)
              .filter(HelpDoc.isParagraph)
              .map((p) => spanText(p.value));
            if (
              !paragraphs
                .slice(1)
                .some(
                  (p) =>
                    p.trim().length > 0 &&
                    !["This setting ", "This option ", "This argument "].some(
                      (note) => p.startsWith(note),
                    ),
                )
            ) {
              const name = (
                spanText(span).match(/--?[\w-]+|<[^>]+>/)?.[0] ?? spanText(span)
              ).replace(/^-+/, "--");
              missing.push(`${path.join(" ")} ${name}`);
            }
          }
        }
        return path;
      }
    }
  };
  // @effect/cli types the descriptor as opaque, hiding nested commands.
  visit(root.descriptor as Descriptor, []);
  return missing;
};

describe("Help text", () => {
  afterEach(cleanupEnvs);

  it("every command, argument, and option has a description", () => {
    // Given
    const root = makeCommand(["docker", "namespace", "fake"]);
    // When
    const missing = undescribed(root);
    // Then
    expect(missing).toEqual([]);
  });

  it("the description check names each place with no description", () => {
    // Given
    const demo = Command.make(
      "demo",
      { x: Args.text({ name: "x" }), y: Options.text("y") },
      () => Effect.void,
    );
    const root = Command.make("tool").pipe(Command.withSubcommands([demo]));
    // When
    const missing = undescribed(root);
    // Then
    expect(missing).toEqual([
      "tool (command)",
      "tool demo (command)",
      "tool demo <x>",
      "tool demo --y",
    ]);
  });

  it("exec --help has a DESCRIPTION section", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["exec", "--help"]);
    // Then
    expect(result.stdout).toContain(
      "run a command in a Sandbox and pass its exit code through",
    );
  });

  it("create --help describes --idle with its format, default, and example", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--help"]);
    // Then
    expect(result.stdout).toContain(
      "delete the Sandbox after this long with no command, for example 15m; default 15m on Linux, 5m on macOS",
    );
  });

  it("create and upload --help say --max-size limits the Work folder", async () => {
    // Given
    const env = makeEnv();
    // When
    const results = await Promise.all(
      ["create", "upload"].map((cmd) => runCli(env, [cmd, "--help"])),
    );
    // Then
    for (const result of results) {
      expect(result.stdout).toContain(
        "the most the Work folder upload may send, MB or GB, for example 800MB; default 500MB",
      );
    }
  });

  it("record stop --help says --max-size limits the Proof video", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["record", "stop", "--help"]);
    // Then
    expect(result.stdout).toContain(
      "the Size limit for the Proof video, MB or GB, for example 20MB; default 10MB",
    );
  });

  it("proofbox auth shows each subcommand's description", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["auth"]);
    // Then
    for (const description of [
      "log in to a Provider",
      "show each Provider's login",
      "delete this machine's Sandboxes on a Provider, then remove its login",
      "make a token for CI from the browser login and print it once",
    ]) {
      expect(result.stdout).toContain(description);
    }
  });

  it("proofbox record shows each subcommand's description", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["record"]);
    // Then
    for (const description of [
      "start a Recording of the Sandbox screen",
      "end the Recording and download its Proof video, or discard it",
    ]) {
      expect(result.stdout).toContain(description);
    }
  });

  it("create --help lists docker | namespace without the fake Provider", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--help"], {
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result.stdout).toContain("--provider docker | namespace");
    expect(result.stdout).not.toContain("| fake");
  });

  it("with PROOFBOX_FAKE_ROOT set, --provider also lists fake", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--help"]);
    // Then
    expect(result.stdout).toContain("--provider docker | namespace | fake");
  });

  it("auth login, logout, and token list the Providers", async () => {
    // Given
    const env = makeEnv();
    // When
    const results = await Promise.all(
      ["login", "logout", "token"].map((sub) =>
        runCli(env, ["auth", sub, "--help"], { unset: ["PROOFBOX_FAKE_ROOT"] }),
      ),
    );
    // Then
    for (const result of results) {
      expect(result.stdout).toContain(
        "One of the following: docker, namespace",
      );
    }
  });

  it("auth login --help lists us | eu for --region", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["auth", "login", "--help"]);
    // Then
    expect(result.stdout).toContain("--region us | eu");
  });

  it("help pages no longer list the built-in options", async () => {
    // Given
    const env = makeEnv();
    const builtIns = ["--completions", "--log-level", "--wizard"];
    const pages = [
      // The top list's last line names --help and --version on purpose.
      { args: ["--help"], hidden: builtIns },
      {
        args: ["create", "--help"],
        hidden: [...builtIns, "--version", "--help"],
      },
      { args: ["auth"], hidden: [...builtIns, "--version", "--help"] },
    ];
    // When
    const results = await Promise.all(
      pages.map(async ({ args, hidden }) => ({
        hidden,
        result: await runCli(env, args),
      })),
    );
    // Then
    for (const { hidden, result } of results) {
      for (const option of hidden) {
        expect(result.stdout).not.toContain(option);
      }
    }
  });

  it("--version still prints the version", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--version"]);
    // Then
    expect(result.stdout).toBe("0.0.0\n\n");
    expect(result.exitCode).toBe(0);
  });

  it("proofbox --help shows the app description", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--help"]);
    // Then
    expect(result.stdout).toContain(
      "rent a disposable Sandbox, drive its screen, and bring back a Proof video",
    );
  });

  it("proofbox --help prints the short command list", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--help"]);
    // Then
    expect(result.stdout).toBe(shortList);
  });

  it("no line of proofbox --help is wider than 100 characters", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--help"]);
    // Then
    expect(
      Math.max(...result.stdout.split("\n").map((line) => line.length)),
    ).toBe(85);
  });

  it("proofbox -h prints the short command list", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["-h"]);
    // Then
    expect(result.stdout).toBe(shortList);
  });

  it("proofbox with no arguments prints the short command list", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, []);
    // Then
    expect(result.stdout).toBe(shortList);
  });
});
