import {
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
import { dirname, join } from "node:path";
import { it as effectIt } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Redacted,
  Ref,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { logoutOfProvider } from "../src/commands/auth.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { changeLogins } from "../src/login/logins-file.ts";
import { type Provider, Providers } from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";
import {
  type FakeNamespace,
  type FakeNamespaceAnswer,
  type FakeNamespaceCall,
  startFakeNamespace,
} from "./support/fake-namespace-api.ts";

// A Namespace JWT the fake Compute API sees (tenant tnt_test, exp
// 3000-01-01T00:00:00Z).
const TOKEN =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig";

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

const lockDir = (home: string) =>
  join(home, ".config", "proofbox", "logins.lock");

const loginsFile = (home: string) =>
  join(home, ".config", "proofbox", "logins.json");

const readSaved = (home: string) =>
  JSON.parse(readFileSync(loginsFile(home), "utf8")) as unknown;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ADA =
  '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const EVE =
  '{"other":{"way":"token","token":"o1k","account":"eve","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const BOTH =
  '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"},"other":{"way":"token","token":"o1k","account":"eve","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const NS_EU =
  '{"namespace":{"way":"token","token":"nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig","account":"tnt_test","expiresAt":"3000-01-01T00:00:00.000Z","region":"eu"}}';

const namespaces: FakeNamespace[] = [];
const fakeNamespace = async (
  answer: (call: FakeNamespaceCall) => FakeNamespaceAnswer,
) => {
  const server = await startFakeNamespace(answer);
  namespaces.push(server);
  return server;
};

describe("auth", () => {
  afterEach(async () => {
    cleanupEnvs();
    for (const server of namespaces.splice(0)) {
      await server.close();
    }
  });

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

  it("a token that is an inherited Object key is rejected", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "toString\n",
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

  it("auth login namespace --token saves the tenant and the region", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token", "--region", "eu"],
      {
        input: `${TOKEN}\n`,
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe("Logged in to namespace as tnt_test.\n");
    expect(result.exitCode).toBe(0);
    expect(ns.calls).toEqual([
      {
        region: "eu",
        method: "ListInstances",
        body: { maxEntries: "1" },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(readSaved(home)).toEqual({
      namespace: {
        way: "token",
        token: TOKEN,
        account: "tnt_test",
        expiresAt: "3000-01-01T00:00:00.000Z",
        region: "eu",
      },
    });
  });

  it("auth login namespace with a token Namespace rejects saves nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({
      error: { code: "unauthenticated", message: "bad token" },
    }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token"],
      {
        input: `${TOKEN}\n`,
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Namespace did not accept this token. It may be wrong, revoked, or expired.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(loginsFile(home))).toBe(false);
  });

  it("auth login namespace with a token that is not a Namespace token asks nothing", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token"],
      {
        input: "not-a-token\n",
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Namespace did not accept this token. It may be wrong, revoked, or expired.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(ns.calls).toEqual([]);
    expect(existsSync(loginsFile(home))).toBe(false);
  });

  it("auth login namespace with a token that cannot list instances names the permission", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({
      error: { code: "permission_denied", message: "denied" },
    }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token"],
      {
        input: `${TOKEN}\n`,
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "This Namespace token lacks permission for ComputeService.ListInstances. Use a token that can manage instances.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(loginsFile(home))).toBe(false);
  });

  it("auth login namespace --region mars names the known regions", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token", "--region", "mars"],
      {
        input: `${TOKEN}\n`,
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      'Unknown region "mars" for namespace: use one of: us, eu\n',
    );
    expect(result.exitCode).toBe(125);
    expect(ns.calls).toEqual([]);
  });

  it("auth login fake --region eu says fake has no regions", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["auth", "login", "fake", "--token", "--region", "eu"],
      { input: "t0k\n", set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe(
      "fake has no regions. Log in without --region.\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth status shows the Namespace env login with its tenant and region", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_TOKEN: TOKEN,
        PROOFBOX_NAMESPACE_REGION: "eu",
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
      },
    });
    // Then
    expect(result.stdout).toContain(
      "namespace  logged in as tnt_test, region eu, expires 3000-01-01T00:00:00Z, env token PROOFBOX_NAMESPACE_TOKEN\n",
    );
    expect(result.exitCode).toBe(0);
    expect(ns.calls.map((call) => call.region)).toEqual(["eu"]);
  });

  it("auth status shows the saved Namespace login with its region", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_EU);
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
      },
    });
    // Then
    expect(result.stdout).toContain(
      "namespace  logged in as tnt_test, region eu, expires 3000-01-01T00:00:00Z, saved login\n",
    );
    expect(result.exitCode).toBe(0);
    expect(ns.calls).toEqual([]);
  });

  it("auth login namespace when Namespace cannot be reached says to check the network", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token"],
      {
        input: `${TOKEN}\n`,
        set: { HOME: home },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Could not reach Namespace. Check your network and try again.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(loginsFile(home))).toBe(false);
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
        "namespace  not logged in\n" +
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
        "namespace  not logged in\n" +
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
        "namespace  not logged in\n" +
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
        "namespace  not logged in\n" +
        "fake  PROOFBOX_FAKE_TOKEN is set, but fake did not accept it\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth status uses the env token when the saved logins file is bad", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("{nope");
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: { HOME: home, PROOFBOX_FAKE_TOKEN: "t0k" },
    });
    // Then
    expect(result.stdout).toBe(
      "docker  no login needed\n" +
        "namespace  not logged in\n" +
        "fake  logged in as ada, expires 2999-01-01T00:00:00Z, env token PROOFBOX_FAKE_TOKEN\n",
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

  it("create with a token the Provider rejects makes no Sandbox", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { HOME: home, PROOFBOX_FAKE_TOKEN: "nope" } },
    );
    // Then
    expect(result.stderr).toBe(
      "Fake did not accept this token. It may be wrong, revoked, or expired.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
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
        "namespace  not logged in\n" +
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

  it("auth logout names the Sandboxes of every region and the region it could not check", async () => {
    // Given: a fake login, two Sandboxes, and a fake region that does not answer
    const env = makeEnv();
    const home = makeHome();
    const set = { HOME: home, PROOFBOX_FAKE_UNREACHED: "eu" };
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
      "Logged out of fake. 2 Sandboxes still run. They stop at their Deadline.\n" +
        "Could not check fake region eu: fake region eu did not answer\n",
    );
    expect(new Set(result.stdout.trim().split("\n"))).toEqual(
      new Set([first.stdout.trim(), second.stdout.trim()]),
    );
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

  it("a login waiting on the logins lock keeps a slot saved meanwhile", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("{}");
    mkdirSync(lockDir(home));
    // When
    const run = runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    await pause(1500);
    writeFileSync(loginsFile(home), EVE);
    rmSync(lockDir(home), { recursive: true });
    const result = await run;
    // Then
    expect(result.stderr).toBe("Logged in to fake as ada.\n");
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({
      other: {
        way: "token",
        token: "o1k",
        account: "eve",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      fake: {
        way: "token",
        token: "t0k",
        account: "ada",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    expect(existsSync(lockDir(home))).toBe(false);
  });

  it("a login waiting on the logins lock names the account saved meanwhile", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome("{}");
    mkdirSync(lockDir(home));
    // When
    const run = runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t1k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    await pause(1500);
    writeFileSync(loginsFile(home), ADA);
    rmSync(lockDir(home), { recursive: true });
    const result = await run;
    // Then
    expect(result.stderr).toBe("Logged in to fake as bob (replaced ada).\n");
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({
      fake: {
        way: "token",
        token: "t1k",
        account: "bob",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
  });

  it("a login stops when the logins lock stays busy", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(ADA);
    mkdirSync(lockDir(home));
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t1k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      `Another proofbox auth command holds ${lockDir(home)}. Try again, or delete it if no other proofbox runs.\n`,
    );
    expect(result.exitCode).toBe(125);
    expect(readFileSync(loginsFile(home), "utf8")).toBe(ADA);
    expect(existsSync(lockDir(home))).toBe(true);
  });

  it("a login that fails inside the logins lock leaves no lock", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    mkdirSync(loginsFile(home), { recursive: true });
    // When
    const result = await runCli(env, ["auth", "login", "fake", "--token"], {
      input: "t0k\n",
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe(
      `Bad logins file ${loginsFile(home)}: could not be read; delete it and log in again\n`,
    );
    expect(result.exitCode).toBe(125);
    expect(existsSync(lockDir(home))).toBe(false);
  });

  it("a logout waiting on the logins lock keeps a slot saved meanwhile", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(ADA);
    mkdirSync(lockDir(home));
    // When
    const run = runCli(env, ["auth", "logout", "fake"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    await pause(1500);
    writeFileSync(loginsFile(home), BOTH);
    rmSync(lockDir(home), { recursive: true });
    const result = await run;
    // Then
    expect(result.stderr).toBe("Logged out of fake.\n");
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({
      other: {
        way: "token",
        token: "o1k",
        account: "eve",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
  });

  it("two logouts at once: one logs out, one finds no saved login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(ADA);
    mkdirSync(lockDir(home));
    // When
    const options = {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    };
    const one = runCli(env, ["auth", "logout", "fake"], options);
    const two = runCli(env, ["auth", "logout", "fake"], options);
    await pause(1500);
    rmSync(lockDir(home), { recursive: true });
    const [first, second] = await Promise.all([one, two]);
    // Then
    expect([first.stderr, second.stderr].sort()).toEqual([
      "Logged out of fake.\n",
      "No saved login for fake.\n",
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({});
  });

  effectIt.effect(
    "logout lists Sandboxes before it takes the logins lock",
    () =>
      Effect.gen(function* () {
        // Given
        const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
        trackTempDir(root);
        const home = makeHome(ADA);
        const listing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const providers = Layer.succeed(
          Providers,
          new Map<string, Provider>([
            [
              "fake",
              {
                ...makeFakeProvider({ root, watch: "none" }),
                list: Deferred.succeed(listing, undefined).pipe(
                  Effect.zipRight(Deferred.await(release)),
                  Effect.as({ infos: [], unreached: [] }),
                ),
              },
            ],
          ]),
        );
        yield* Effect.gen(function* () {
          // When
          const fiber = yield* Effect.fork(logoutOfProvider("fake"));
          yield* Deferred.await(listing);
          yield* changeLogins((logins) => ({
            ...logins,
            other: {
              way: "token",
              token: Redacted.make("o1k"),
              account: "eve",
              expiresAt: new Date("2999-01-01T00:00:00.000Z"),
            },
          }));
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          // Then
          const output = yield* CliOutput;
          const stderr = Chunk.toReadonlyArray(
            yield* Ref.get(output.captured.err),
          ).join("");
          expect(stderr).toBe("Logged out of fake.\n");
          expect(readSaved(home)).toEqual({
            other: {
              way: "token",
              token: "o1k",
              account: "eve",
              expiresAt: "2999-01-01T00:00:00.000Z",
            },
          });
        }).pipe(
          Effect.provide(Layer.mergeAll(CliOutput.Test, providers)),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([["HOME", home]])),
          ),
        );
      }),
  );

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
