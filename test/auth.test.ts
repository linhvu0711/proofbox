import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";

const makeHome = (logins?: string): string => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-home-"));
  trackTempDir(home);
  if (logins !== undefined) {
    const dir = join(home, ".config", "proofbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "logins.json"), logins);
  }
  return home;
};

describe("auth", () => {
  afterEach(cleanupEnvs);

  it("auth login --token saves the login, owner-only", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    const path = join(home, ".config", "proofbox", "logins.json");
    expect(result.stderr).toBe("Logged in to fake as ada.\n");
    expect(result.exitCode).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      fake: {
        way: "token",
        token: "t0k",
        account: "ada",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
  });

  it("a token the Provider rejects saves nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "nope\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      "Fake did not accept this token. It may be wrong, revoked, or expired.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(() =>
      statSync(join(home, ".config", "proofbox", "logins.json")),
    ).toThrow();
  });

  it("a logins.json that is not JSON fails with one line naming the file", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("{nope");
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      `Bad logins file ${home}/.config/proofbox/logins.json: not JSON; delete it and log in again\n`,
    );
    expect(result.exitCode).toBe(125);
    expect(
      readFileSync(join(home, ".config", "proofbox", "logins.json"), "utf8"),
    ).toBe("{nope");
  });

  it("a logins.json of the wrong shape fails with one line naming the file", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome('{"fake": 1}');
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      `Bad logins file ${home}/.config/proofbox/logins.json: not a logins file; delete it and log in again\n`,
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth login with an unknown Provider names the known ones", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "foo"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result.stderr).toBe(
      'No provider named "foo". Providers: docker, namespace.\n',
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth login docker says no login is needed", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "docker"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe("docker needs no login.\n");
    expect(result.exitCode).toBe(125);
  });

  it("auth login without --token asks for --token", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "fake"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe("fake has no browser login. Use --token.\n");
    expect(result.exitCode).toBe(125);
  });

  it("auth login namespace points to nsc for now", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "namespace logs in with nsc for now. Run: nsc login\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("a second login replaces the first and names the old account", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const set = { HOME: home };
    const unset = ["PROOFBOX_FAKE_TOKEN"];
    await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set,
      unset,
    });
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t1k\n",
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe("Logged in to fake as bob (replaced ada).\n");
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(home, ".config", "proofbox", "logins.json"), "utf8"),
      ),
    ).toEqual({
      fake: {
        way: "token",
        token: "t1k",
        account: "bob",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
  });

  it("auth login --token with nothing on stdin saves nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      "No token on stdin. Run: echo <token> | proofbox auth login fake --token\n",
    );
    expect(result.exitCode).toBe(125);
    expect(() =>
      statSync(join(home, ".config", "proofbox", "logins.json")),
    ).toThrow();
  });
});
