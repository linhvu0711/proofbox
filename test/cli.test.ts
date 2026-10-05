import { Command } from "@effect/cli";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { commandList, commandWords } from "../src/cli.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("CLI", () => {
  afterEach(cleanupEnvs);

  it("command lookup uses the registered command tree and nested groups", () => {
    const providers = ["docker", "namespace", "fake"];
    for (const [args, expected] of [
      [[], ""],
      [["nosuch"], ""],
      [["exec", "fake:1"], "exec"],
      [["auth", "login", "fake"], "auth login"],
      [["auth", "status"], "auth status"],
      [["auth", "logout"], "auth logout"],
      [["auth", "token"], "auth token"],
      [["record", "start"], "record start"],
      [["record", "stop"], "record stop"],
      [["record", "nosuch"], "record"],
    ] as const) {
      expect(commandWords(args, providers)).toBe(expected);
    }
  });

  it("the command list comes from the command tree, groups indented", () => {
    // Given
    const demo = Command.make("demo", {}, () => Effect.void).pipe(
      Command.withDescription("run the demo"),
    );
    const child = Command.make("child", {}, () => Effect.void).pipe(
      Command.withDescription("a child"),
    );
    const group = Command.make("group").pipe(
      Command.withDescription("a group"),
      Command.withSubcommands([child]),
    );
    const root = Command.make("tool").pipe(
      Command.withDescription("a tool"),
      Command.withSubcommands([demo, group]),
    );
    // When
    const list = commandList(root);
    // Then
    expect(list).toBe(
      "USAGE\n\n$ tool <command>\n\nDESCRIPTION\n\na tool\n\nCOMMANDS\n\n  demo     run the demo\n  group    a group\n    child  a child\n\nRun tool <command> --help for its options. tool --version prints the version.\n",
    );
  });

  it("with FORCE_COLOR=1 a missing argument prints ✘ and the help to read", async () => {
    const env = makeEnv();
    const result = await runCli(env, ["exec"], { set: { FORCE_COLOR: "1" } });
    expect(result.stderr).toBe(
      "\u001b[31m✘\u001b[0m Missing argument <id>\n\u001b[2m  see proofbox exec --help\u001b[0m\n",
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(125);
  });

  it("a parser error in a nested command names both words", async () => {
    const env = makeEnv();
    const result = await runCli(env, ["auth", "status", "--nope"], {
      set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
    });
    expect(result.stderr).toBe(
      "✘ Received unknown argument: '--nope'\n  see proofbox auth status --help\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("an unknown command points at the top help", async () => {
    const env = makeEnv();
    const result = await runCli(env, ["nosuch"], {
      set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
    });
    expect(
      result.stderr.startsWith(
        "✘ Invalid subcommand for proofbox - use one of ",
      ),
    ).toBe(true);
    expect(result.stderr.endsWith("'auth'\n  see proofbox --help\n")).toBe(
      true,
    );
    expect(result.exitCode).toBe(125);
  });

  it("without a terminal a parser error prints today's bytes", async () => {
    const env = makeEnv();
    const result = await runCli(env, ["exec"]);
    expect(result.stderr).toBe("Missing argument <id>\n\n");
    expect(result.exitCode).toBe(125);
  });
});
