import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("CLI", () => {
  afterEach(cleanupEnvs);

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
