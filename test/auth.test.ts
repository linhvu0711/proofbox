import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("auth status with no logins shows not logged in", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  logs in with nsc for now\n" +
        "fake  not logged in\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth status shows the saved login", async () => {
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
    const result = await runCli(env, ["auth", "status"], { set, unset });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  logs in with nsc for now\n" +
        "fake  logged in as ada, expires 2999-01-01T00:00:00Z, saved login\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth status uses the env token over the saved login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t1k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home, PROOFBOX_FAKE_TOKEN: "t0k" },
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  logs in with nsc for now\n" +
        "fake  logged in as ada, expires 2999-01-01T00:00:00Z, env token PROOFBOX_FAKE_TOKEN\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth status says when the env token is not accepted", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home, PROOFBOX_FAKE_TOKEN: "nope" },
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  logs in with nsc for now\n" +
        "fake  PROOFBOX_FAKE_TOKEN is set, but fake did not accept it\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("create with no Provider login says how to log in", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { HOME: home }, unset: ["PROOFBOX_FAKE_TOKEN"] },
    );
    // Then
    expect(result.stderr).toBe(
      "Not logged in to fake. Run: proofbox auth login fake\n",
    );
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
  });

  it("create with an expired saved login says it expired", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2000-01-01T00:00:00.000Z"}}',
    );
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { HOME: home }, unset: ["PROOFBOX_FAKE_TOKEN"] },
    );
    // Then
    expect(result.stderr).toBe(
      "Your Provider login for fake expired. Run: proofbox auth login fake\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("create with a saved login makes the Sandbox", async () => {
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
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set, unset },
    );
    // Then
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.exitCode).toBe(0);
  });

  it("auth status shows an expired saved login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2000-01-01T00:00:00.000Z"}}',
    );
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  logs in with nsc for now\n" +
        "fake  expired 2000-01-01T00:00:00Z. Run: proofbox auth login fake\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth logout removes the login and names the Sandboxes that still run", async () => {
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
    const first = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set, unset },
    );
    const second = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set, unset },
    );
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. 2 Sandboxes still run. They stop at their Deadline.\n",
    );
    expect(new Set(result.stdout.trim().split("\n"))).toEqual(
      new Set([first.stdout.trim(), second.stdout.trim()]),
    );
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(home, ".config", "proofbox", "logins.json"), "utf8"),
      ),
    ).toEqual({});
  });

  it("auth logout names one Sandbox in the singular", async () => {
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
    const sandbox = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set, unset },
    );
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. 1 Sandbox still runs. It stops at its Deadline.\n",
    );
    expect(result.stdout).toBe(sandbox.stdout);
    expect(result.exitCode).toBe(0);
  });

  it("auth logout with no Sandboxes only logs out", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"}}',
    );
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe("Logged out of fake.\n");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("auth logout still removes the login when it cannot list Sandboxes", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"}}',
    );
    const file = join(mkdtempSync(join(tmpdir(), "proofbox-file-")), "f");
    trackTempDir(dirname(file));
    writeFileSync(file, "x");
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set: { HOME: home, PROOFBOX_FAKE_ROOT: file },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. Could not check for running Sandboxes. Any left stop at their Deadline.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(home, ".config", "proofbox", "logins.json"), "utf8"),
      ),
    ).toEqual({});
  });

  it("auth logout with no saved login says so", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe("No saved login for fake.\n");
    expect(result.exitCode).toBe(0);
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
