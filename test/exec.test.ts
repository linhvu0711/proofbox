import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupEnvs,
  keeperCannotStart,
  makeEnv,
  runCli,
} from "./support/cli.ts";

describe("exec", () => {
  afterEach(cleanupEnvs);

  it("an exec with no Keeper warns once and still runs the command", async () => {
    // Given: a Sandbox whose Keeper cannot start
    const env = makeEnv();
    const set = keeperCannotStart(env);
    const created = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set },
    );
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["exec", id, "--", "echo", "x"], { set });
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x\n");
    expect(result.stderr).toBe(
      "proofbox: Keeper did not start; running without it\n",
    );
  });

  it("exec passes stdout, stderr, and exit code unchanged", async () => {
    // Given: a created Sandbox id
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "printf 'a\\nb'; printf err >&2; exit 3",
    ]);
    // Then
    expect(result.stdout).toBe("a\nb");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(3);
  });

  it("exec keeps each arg whole, even --help", async () => {
    // Given: a created Sandbox id
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "printf",
      "%s|",
      "a b",
      "it's",
      "--help",
    ]);
    // Then
    expect(result.stdout).toBe("a b|it's|--help|");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("exec runs in the Sandbox folder", async () => {
    // Given: a created Sandbox id
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const name = id.replace("fake:", "");
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "echo hi > f.txt",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(env.root, name, "home", "f.txt"), "utf8")).toBe(
      "hi\n",
    );
  });

  it("exec has no time limit", async () => {
    // Given: a created Sandbox id, and a helper wait of 1 s
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When: the command runs for 2 s
    const result = await runCli(
      env,
      ["exec", id, "--", "sh", "-c", "sleep 2; echo done"],
      { set: { PROOFBOX_ANSWER_WAIT: "1s" } },
    );
    // Then
    expect({ stdout: result.stdout, exitCode: result.exitCode }).toEqual({
      stdout: "done\n",
      exitCode: 0,
    });
  });
});
