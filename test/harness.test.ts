import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  it("auth status shows one line per saved Harness login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"claude":{"token":"sk-ant-oat01-abcd","expiresAt":"2999-01-01T00:00:00.000Z"},"codex":{"token":"sk-proj-wxyz"}}',
    );
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\nnamespace  not logged in\nfake  not logged in\nharness claude  token …abcd, expires 2999-01-01T00:00:00Z, saved login\nharness codex  API key …wxyz, saved login\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth status shows an expired Harness login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"claude":{"token":"sk-ant-oat01-abcd","expiresAt":"2000-01-01T00:00:00.000Z"}}',
    );
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\nnamespace  not logged in\nfake  not logged in\nharness claude  expired 2000-01-01T00:00:00Z. Run: proofbox harness login claude\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("harness login and auth status leave ~/.claude and ~/.codex alone", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const claude = join(home, ".claude");
    const codex = join(home, ".codex");
    mkdirSync(claude);
    mkdirSync(codex);
    writeFileSync(join(claude, "settings.json"), '{"a":1}');
    writeFileSync(join(codex, "auth.json"), '{"b":2}');
    chmodSync(claude, 0o000);
    chmodSync(codex, 0o000);
    try {
      // When
      const loginClaude = await runCli(env, ["harness", "login", "claude"], {
        input: "sk-ant-oat01-abcd\n",
        set: { HOME: home },
      });
      const loginCodex = await runCli(env, ["harness", "login", "codex"], {
        input: "sk-proj-wxyz\n",
        set: { HOME: home },
      });
      const status = await runCli(env, ["auth", "status"], {
        set: { HOME: home },
        unset: ["PROOFBOX_FAKE_TOKEN"],
      });
      // Then
      expect([
        loginClaude.exitCode,
        loginCodex.exitCode,
        status.exitCode,
      ]).toEqual([0, 0, 0]);
      expect(status.stdout).toContain("harness claude  token …abcd, expires ");
      expect(status.stdout).toContain(
        "harness codex  API key …wxyz, saved login\n",
      );
      expect(statSync(claude).mode & 0o777).toBe(0o000);
      expect(statSync(codex).mode & 0o777).toBe(0o000);
    } finally {
      chmodSync(claude, 0o700);
      chmodSync(codex, 0o700);
    }
    expect(readdirSync(claude)).toEqual(["settings.json"]);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe('{"a":1}');
    expect(readdirSync(codex)).toEqual(["auth.json"]);
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe('{"b":2}');
  });

  it("harness login claude with only spaces on stdin names claude setup-token and saves nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "claude"], {
      input: "   \n",
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "No token on stdin. Make one with `claude setup-token`, then run: echo <token> | proofbox harness login claude\n",
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(join(home, ".config", "proofbox"))).toBe(false);
  });

  it("harness login codex with nothing on stdin names the OpenAI API keys page and saves nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "login", "codex"], {
      input: "",
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "No API key on stdin. Make one at https://platform.openai.com/api-keys, then run: echo <key> | proofbox harness login codex\n",
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(join(home, ".config", "proofbox"))).toBe(false);
  });

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
