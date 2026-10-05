import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Capability", () => {
  afterEach(cleanupEnvs);

  it("create --os macos on fake is refused before anything is made", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "macos",
      "--provider",
      "fake",
    ]);
    // Then
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability os:macos; nothing was created\n",
    );
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
  });

  it("screenshot on a Provider with no desktop is refused", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const out = join(env.root, "shot.png");
    // When
    const result = await runCli(env, ["screenshot", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
    expect(existsSync(out)).toBe(false);
  });

  it("click on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["click", id, "10", "10"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("drag on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["drag", id, "10", "10", "20", "20"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("key on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["key", id, "ctrl+s"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("key refuses --glide, which it does not use", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "key",
      "fake:none",
      "Return",
      "--glide",
      "2s",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("Received unknown argument: '--glide'");
    expect(result.stderr).not.toContain("Provider fake");
  });

  it.each([
    {
      command: "click",
      args: ["click", "fake:none", "10", "10"],
      flag: "--letter",
    },
    {
      command: "click",
      args: ["click", "fake:none", "10", "10"],
      flag: "--type-max",
    },
    {
      command: "scroll",
      args: ["scroll", "fake:none", "10", "10", "down"],
      flag: "--letter",
    },
    {
      command: "scroll",
      args: ["scroll", "fake:none", "10", "10", "down"],
      flag: "--type-max",
    },
    {
      command: "drag",
      args: ["drag", "fake:none", "10", "10", "20", "20"],
      flag: "--letter",
    },
    {
      command: "drag",
      args: ["drag", "fake:none", "10", "10", "20", "20"],
      flag: "--type-max",
    },
    { command: "key", args: ["key", "fake:none", "Return"], flag: "--letter" },
    {
      command: "key",
      args: ["key", "fake:none", "Return"],
      flag: "--type-max",
    },
    { command: "type", args: ["type", "fake:none", "hello"], flag: "--glide" },
  ])(
    "$command refuses $flag, which it does not use",
    async ({ args, flag }) => {
      // Given
      const env = makeEnv();
      // When
      const result = await runCli(env, [...args, flag, "10ms"]);
      // Then
      expect(result.exitCode).toBe(125);
      expect(result.stderr).toContain(`Received unknown argument: '${flag}'`);
      expect(result.stderr).not.toContain("Provider fake");
    },
  );

  it.each([
    { command: "click", args: ["10", "10"], flag: "--glide", value: "10ms" },
    { command: "click", args: ["10", "10"], flag: "--settle", value: "10ms" },
    {
      command: "scroll",
      args: ["10", "10", "down"],
      flag: "--glide",
      value: "10ms",
    },
    {
      command: "scroll",
      args: ["10", "10", "down"],
      flag: "--settle",
      value: "10ms",
    },
    {
      command: "drag",
      args: ["10", "10", "20", "20"],
      flag: "--glide",
      value: "10ms",
    },
    {
      command: "drag",
      args: ["10", "10", "20", "20"],
      flag: "--settle",
      value: "10ms",
    },
    { command: "type", args: ["hello"], flag: "--letter", value: "10ms" },
    { command: "type", args: ["hello"], flag: "--type-max", value: "10ms" },
    { command: "type", args: ["hello"], flag: "--settle", value: "10ms" },
    { command: "key", args: ["Return"], flag: "--settle", value: "10ms" },
    { command: "key", args: ["Return"], flag: "--pace", value: "fast" },
    {
      command: "key",
      args: ["Return"],
      flag: "--screenshot",
      value: "shot.png",
    },
  ])("$command still takes $flag", async ({ command, args, flag, value }) => {
    // Given
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
    const result = await runCli(env, [command, id, ...args, flag, value]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("scroll still takes a step count", async () => {
    // Given
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
    const result = await runCli(env, ["scroll", id, "10", "10", "down", "5"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("scroll refuses a step count that is not a number", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "scroll",
      "fake:none",
      "10",
      "10",
      "down",
      "x",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("'x' is not a integer");
  });

  it("scroll refuses a step count that is too large", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "scroll",
      "fake:none",
      "10",
      "10",
      "down",
      "99999999999999999999",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("'99999999999999999999' is not a integer");
  });

  it("key --help lists only the flags key uses", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["key", "--help"]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "$ key [--screenshot text] [--pace human | fast] [--settle text] <id> <keys>",
    );
    expect(result.stdout).not.toContain("--glide");
  });

  it("scroll on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["scroll", id, "10", "10", "down"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("type on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["type", id, "hello"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no action was taken\n",
    );
  });

  it("record start on a Provider with no desktop is refused", async () => {
    // Given
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
    const result = await runCli(env, ["record", "start", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability desktop; no Recording was started\n",
    );
  });

  it("create with an unknown Provider names the Providers", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "nope",
    ]);
    // Then
    expect(result.stderr).toBe(
      "Expected one of the following cases: docker, namespace, fake\n\n",
    );
    expect(result.exitCode).toBe(125);
  });
});
