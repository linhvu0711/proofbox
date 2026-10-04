import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { harnessEntryFor, saveHarnessLogin } from "../src/commands/harness.ts";
import { HarnessesLive } from "../src/harness-registry.ts";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";

const makeHome = (logins?: string): string => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-home-"));
  trackTempDir(home);
  if (logins !== undefined) {
    const dir = join(home, ".config", "proofbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "harness-logins.json"), logins);
  }
  return home;
};

const loginsFile = (home: string) =>
  join(home, ".config", "proofbox", "harness-logins.json");
const lockDir = (home: string) =>
  join(home, ".config", "proofbox", "logins.lock");
const readSaved = (home: string): unknown =>
  JSON.parse(readFileSync(loginsFile(home), "utf8"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(cleanupEnvs);

describe("Harness logins", () => {
  it("harness login codex saves the API key, owner-only", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "codex"], {
      input: "sk-proj-wxyz\n",
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "Saved Harness login for codex with API key …wxyz.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(statSync(loginsFile(home)).mode & 0o777).toBe(0o600);
    expect(readSaved(home)).toEqual({ codex: { token: "sk-proj-wxyz" } });
  });

  it("harness login foo names the known Harnesses", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "foo"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result.stderr).toBe(
      'No Harness named "foo". Harnesses: claude, codex.\n',
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(loginsFile(home))).toBe(false);
  });

  it("harness login fake is unknown outside tests", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "fake"], {
      input: "f4ke\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result.stderr).toBe(
      'No Harness named "fake". Harnesses: claude, codex.\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("two harness logins at once both save", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const results = await Promise.all([
      runCli(env, ["harness", "login", "claude"], {
        input: "sk-ant-oat01-abcd\n",
        set: { HOME: home },
      }),
      runCli(env, ["harness", "login", "codex"], {
        input: "sk-proj-wxyz\n",
        set: { HOME: home },
      }),
    ]);
    // Then
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(readSaved(home)).toMatchObject({
      claude: { token: "sk-ant-oat01-abcd" },
      codex: { token: "sk-proj-wxyz" },
    });
  });

  it("harness login claude saves the token, owner-only", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "claude"], {
      input: "sk-ant-oat01-abcd\n",
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "Saved Harness login for claude with token …abcd.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(statSync(loginsFile(home)).mode & 0o777).toBe(0o600);
    expect(readSaved(home)).toMatchObject({
      claude: { token: "sk-ant-oat01-abcd" },
    });
    expect(existsSync(join(home, ".config", "proofbox", "logins.json"))).toBe(
      false,
    );
  });

  effectIt.effect(
    "a Claude Harness login ends 365 days after it was saved",
    () =>
      Effect.gen(function* () {
        // Given
        const home = makeHome();
        // When
        yield* Effect.gen(function* () {
          yield* saveHarnessLogin(
            yield* harnessEntryFor("claude"),
            "sk-ant-oat01-abcd\n",
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(NodeContext.layer, CliOutput.Test, HarnessesLive),
          ),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([["HOME", home]])),
          ),
        );
        // Then
        expect(readSaved(home)).toEqual({
          claude: {
            token: "sk-ant-oat01-abcd",
            expiresAt: "1971-01-01T00:00:00.000Z",
          },
        });
      }),
  );

  it("a harness login waiting on the logins lock keeps a login saved meanwhile", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("{}");
    mkdirSync(lockDir(home));
    // When
    const run = runCli(env, ["harness", "login", "claude"], {
      input: "sk-ant-oat01-abcd\n",
      set: { HOME: home },
    });
    await pause(1500);
    writeFileSync(loginsFile(home), '{"codex":{"token":"sk-proj-wxyz"}}');
    rmSync(lockDir(home), { recursive: true });
    const result = await run;
    // Then
    expect(result.stderr).toBe(
      "Saved Harness login for claude with token …abcd.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toMatchObject({
      codex: { token: "sk-proj-wxyz" },
      claude: { token: "sk-ant-oat01-abcd" },
    });
    expect(existsSync(lockDir(home))).toBe(false);
  });

  it("harness login with a bad harness-logins.json fails with one line naming the file", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("nope");
    // When
    const result = await runCli(env, ["harness", "login", "claude"], {
      input: "sk-ant-oat01-abcd\n",
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      `Bad logins file ${loginsFile(home)}: not JSON; delete it and log in again\n`,
    );
    expect(result.exitCode).toBe(125);
    expect(readFileSync(loginsFile(home), "utf8")).toBe("nope");
  });
});
