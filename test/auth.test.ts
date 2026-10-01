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
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  TestClock,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import {
  loginToProvider,
  logoutOfProvider,
  makeRobotToken,
} from "../src/commands/auth.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { changeLogins } from "../src/login/logins-file.ts";
import {
  type Provider,
  Providers,
  type TokenRequest,
} from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";
import {
  type FakeNamespace,
  type FakeNamespaceAnswer,
  type FakeNamespaceCall,
  type FakeSignin,
  fakeSignin,
  SESSION_1,
  SESSION_2,
  startFakeNamespace,
  TENANT_1,
  toSnakeKeys,
} from "./support/fake-namespace-api.ts";
import { makeFakeOpen } from "./support/fake-open.ts";

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

// A fake Sandbox id is `fake:<name>`; its files are named by the name.
const nameOf = (id: string) => id.slice("fake:".length);

// A fake login in its own HOME, then `count` Sandboxes made through the CLI
// on this machine. `extra` env goes on every run.
const fakeLoginWith = async (
  count: number,
  extra: Readonly<Record<string, string>> = {},
) => {
  const env = makeEnv();
  const home = makeHome();
  const set = { HOME: home, ...extra };
  const unset = ["PROOFBOX_FAKE_TOKEN"];
  await runCli(env, ["auth", "login", "fake", "--token"], {
    input: "t0k\n",
    set,
    unset,
  });
  const ids: Array<string> = [];
  for (let i = 0; i < count; i++) {
    const made = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set, unset },
    );
    ids.push(made.stdout.trim());
  }
  return { env, home, set, unset, ids };
};

const ADA =
  '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const EVE =
  '{"other":{"way":"token","token":"o1k","account":"eve","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const BOTH =
  '{"fake":{"way":"token","token":"t0k","account":"ada","expiresAt":"2999-01-01T00:00:00.000Z"},"other":{"way":"token","token":"o1k","account":"eve","expiresAt":"2999-01-01T00:00:00.000Z"}}';
const NS_EU =
  '{"namespace":{"way":"token","token":"nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig","account":"tnt_test","expiresAt":"3000-01-01T00:00:00.000Z","region":"eu"}}';
const NS_BROWSER = `{"namespace":{"way":"browser","session":"${SESSION_1}","account":"team-1","expiresAt":"3000-01-01T00:00:00.000Z"}}`;
const NS_BROWSER_EU = `{"namespace":{"way":"browser","session":"${SESSION_1}","account":"team-1","expiresAt":"3000-01-01T00:00:00.000Z","region":"eu"}}`;
const NS_BROWSER_EXPIRED = `{"namespace":{"way":"browser","session":"${SESSION_1}","account":"team-1","expiresAt":"2000-01-01T00:00:00.000Z"}}`;

// A tenant token JWT for tnt_team1 that ends in `seconds`.
const tenantTokenEndingIn = (seconds: number) =>
  `nsct_${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(
      toSnakeKeys({
        tenantId: "tnt_team1",
        exp: Math.floor(Date.now() / 1000) + seconds,
      }),
    ),
  ).toString("base64url")}.sig`;

const namespaces: FakeNamespace[] = [];
const fakeNamespace = async (
  answer: (call: FakeNamespaceCall) => FakeNamespaceAnswer,
) => {
  const server = await startFakeNamespace(answer);
  namespaces.push(server);
  return server;
};

// A fake that plays IAM and Compute: the sign-in calls go to `signin`,
// the Compute calls to `answer` (`{json:{}}` by default).
const fakeNamespaceSignin = async (
  signin?: FakeSignin,
  answer: (call: FakeNamespaceCall) => FakeNamespaceAnswer = () => ({
    json: {},
  }),
) => {
  const server = await startFakeNamespace(answer, 0, signin ?? fakeSignin());
  namespaces.push(server);
  return server;
};

// The fake's IAM base: its url without the `/{region}` tail.
const iamUrl = (server: FakeNamespace) => server.url.replace("/{region}", "");

// Waits for the held CompleteTenantLogin, then clicks the fake login
// page's button like a person would.
const clickWhenWaiting = async (
  server: FakeNamespace,
  loginId = "L1",
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!server.calls.some((call) => call.method === "CompleteTenantLogin")) {
    if (Date.now() > deadline) {
      throw new Error("CompleteTenantLogin never arrived");
    }
    await pause(50);
  }
  const res = await fetch(`${iamUrl(server)}/login/${loginId}`, {
    method: "POST",
  });
  await res.text();
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

  it("auth login namespace with an opaque token Namespace rejects saves nothing", async () => {
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
        input: "nsrt_opaque0000a1b2\n",
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
    expect(ns.calls).toEqual([
      {
        region: "us",
        method: "ListInstances",
        body: { maxEntries: "1" },
        authorization: "Bearer nsrt_opaque0000a1b2",
      },
    ]);
    expect(existsSync(loginsFile(home))).toBe(false);
  });

  it("auth login namespace --token accepts an opaque token", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--token"],
      {
        input: "nsrt_opaque0000a1b2\n",
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe("Logged in to namespace with token …a1b2.\n");
    expect(result.exitCode).toBe(0);
    expect(ns.calls).toEqual([
      {
        region: "us",
        method: "ListInstances",
        body: { maxEntries: "1" },
        authorization: "Bearer nsrt_opaque0000a1b2",
      },
    ]);
    expect(readSaved(home)).toEqual({
      namespace: {
        way: "token",
        token: "nsrt_opaque0000a1b2",
      },
    });
  });

  it("auth status shows an opaque saved Namespace token", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      '{"namespace":{"way":"token","token":"nsrt_opaque0000a1b2","region":"us"}}',
    );
    const ns = await fakeNamespace(() => {
      throw new Error("no calls wanted");
    });
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
      },
    });
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "namespace  logged in with token …a1b2, region us, expiry not known, saved login\n",
    );
    expect(ns.calls).toEqual([]);
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

  it("auth logout deletes the Sandboxes this machine started", async () => {
    // Given
    const { env, home, set, unset, ids } = await fakeLoginWith(2);
    const [name1 = "", name2 = ""] = ids.map(nameOf);
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe("Logged out of fake. Deleted 2 Sandboxes.\n");
    expect(new Set(result.stdout.trim().split("\n"))).toEqual(new Set(ids));
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({});
    expect(existsSync(join(env.root, name1))).toBe(false);
    expect(existsSync(join(env.root, name2))).toBe(false);
    expect(existsSync(join(env.runtime, `fake-${name1}.max-life`))).toBe(false);
    expect(existsSync(join(env.runtime, `fake-${name2}.max-life`))).toBe(false);
  });

  it("auth logout names one deleted Sandbox in the singular", async () => {
    // Given
    const { env, set, unset, ids } = await fakeLoginWith(1);
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe("Logged out of fake. Deleted 1 Sandbox.\n");
    expect(result.stdout).toBe(`${ids[0]}\n`);
    expect(result.exitCode).toBe(0);
  });

  it("auth logout counts a Sandbox whose host is already gone as deleted", async () => {
    // Given: the host is gone, its Max life file stays
    const { env, set, unset, ids } = await fakeLoginWith(1);
    const name = nameOf(ids[0] ?? "");
    rmSync(join(env.root, name), { recursive: true, force: true });
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe("Logged out of fake. Deleted 1 Sandbox.\n");
    expect(result.stdout).toBe(`${ids[0]}\n`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(env.runtime, `fake-${name}.max-life`))).toBe(false);
  });

  it("auth logout leaves a Sandbox started elsewhere and names it", async () => {
    // Given: one Sandbox from this machine, one from another machine (its
    // own runtime dir) on the same fake account
    const { env, set, unset, ids } = await fakeLoginWith(1);
    const other = mkdtempSync(join("/tmp", "proofbox-runtime-"));
    trackTempDir(other);
    const theirs = (
      await runCli(env, ["create", "--os", "linux", "--provider", "fake"], {
        set: { ...set, PROOFBOX_RUNTIME_DIR: other },
        unset,
      })
    ).stdout.trim();
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      `Logged out of fake. Deleted 1 Sandbox.\n${theirs} still runs, started elsewhere.\n`,
    );
    expect(result.stdout).toBe(`${ids[0]}\n`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(env.root, nameOf(theirs)))).toBe(true);
  });

  it("auth logout deletes the rest when one delete fails", async () => {
    // Given
    const { env, home, set, unset, ids } = await fakeLoginWith(2);
    const [first = "", second = ""] = ids;
    const name1 = nameOf(first);
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set: { ...set, PROOFBOX_FAKE_DELETE_DOWN: name1 },
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. Deleted 1 Sandbox.\n" +
        `Could not delete ${first}: fake Sandbox ${name1} did not answer\n`,
    );
    expect(result.stdout).toBe(`${second}\n`);
    expect(result.exitCode).toBe(125);
    expect(readSaved(home)).toEqual({});
    expect(existsSync(join(env.root, name1))).toBe(true);
    expect(existsSync(join(env.runtime, `fake-${name1}.pid`))).toBe(false);
  });

  it("auth logout names the region it could not check and still deletes", async () => {
    // Given: a fake login, two Sandboxes, and a fake region that does not answer
    const { env, set, unset, ids } = await fakeLoginWith(2, {
      PROOFBOX_FAKE_UNREACHED: "eu",
    });
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set,
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. Deleted 2 Sandboxes.\n" +
        "Could not check fake region eu: fake region eu did not answer\n",
    );
    expect(new Set(result.stdout.trim().split("\n"))).toEqual(new Set(ids));
    expect(result.exitCode).toBe(125);
  });

  it("auth logout namespace removes the nsc token files", async () => {
    // Given: a saved namespace login, an nsc token file, and a reachable
    // Namespace that lists no Sandboxes
    const env = makeEnv();
    const home = makeHome(
      `{"namespace":{"way":"token","token":"${TOKEN}","account":"tnt_test","expiresAt":"3000-01-01T00:00:00.000Z","region":"us"}}`,
    );
    const tokenFile = join(env.runtime, "ns-token-0123456789abcdef.json");
    writeFileSync(tokenFile, `{"bearer_token":"${TOKEN}"}\n`);
    const ns = await fakeNamespace(() => ({ json: {} }));
    // When
    const result = await runCli(env, ["auth", "logout", "namespace"], {
      set: { HOME: home, PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url },
      unset: ["PROOFBOX_FAKE_TOKEN"],
    });
    // Then
    expect(result.stderr).toBe("Logged out of namespace.\n");
    expect(result.exitCode).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
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

  it("auth logout still deletes and removes the login when it cannot list Sandboxes", async () => {
    // Given
    const { env, home, set, unset, ids } = await fakeLoginWith(1);
    // When
    const result = await runCli(env, ["auth", "logout", "fake"], {
      set: { ...set, PROOFBOX_FAKE_LIST_DOWN: "fake API is down" },
      unset,
    });
    // Then
    expect(result.stderr).toBe(
      "Logged out of fake. Deleted 1 Sandbox.\nCould not check fake: fake API is down\n",
    );
    expect(result.stdout).toBe(`${ids[0]}\n`);
    expect(result.exitCode).toBe(125);
    expect(readSaved(home)).toEqual({});
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
        const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
        trackTempDir(runtime);
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
          Effect.provide(
            Layer.mergeAll(
              CliOutput.Test,
              providers,
              KeeperClient.Direct.pipe(Layer.provide(providers)),
            ),
          ),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(
              new Map([
                ["HOME", home],
                ["PROOFBOX_RUNTIME_DIR", runtime],
              ]),
            ),
          ),
        );
      }),
  );

  it("auth login namespace opens the browser and saves the workspace login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_OPEN: makeFakeOpen('curl -fsS -X POST "$1" >/dev/null'),
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Waiting for you to log in in the browser... (Ctrl+C to stop)\nLogged in to namespace as team-1.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(ns.calls).toEqual([
      {
        region: "",
        method: "StartLogin",
        body: toSnakeKeys({
          supportedKinds: ["tenant"],
          sessionDurationSecs: 2592000,
        }),
        authorization: undefined,
      },
      {
        region: "",
        method: "CompleteTenantLogin",
        body: toSnakeKeys({ loginId: "L1" }),
        authorization: undefined,
      },
    ]);
    const path = join(home, ".config", "proofbox", "logins.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      namespace: {
        way: "browser",
        session: SESSION_1,
        account: "team-1",
        expiresAt: "3000-01-01T00:00:00.000Z",
      },
    });
  });

  it("auth login namespace --region eu saves eu", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(
      env,
      ["auth", "login", "namespace", "--region", "eu"],
      {
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
          PROOFBOX_OPEN: makeFakeOpen('curl -fsS -X POST "$1" >/dev/null'),
        },
      },
    );
    // Then
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({
      namespace: {
        way: "browser",
        session: SESSION_1,
        account: "team-1",
        expiresAt: "3000-01-01T00:00:00.000Z",
        region: "eu",
      },
    });
  });

  it("a second browser login replaces the first and names the old workspace", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(
      `{"namespace":{"way":"browser","session":"${SESSION_1}","account":"team-1","expiresAt":"3000-01-01T00:00:00.000Z"}}`,
    );
    const ns = await fakeNamespaceSignin(
      fakeSignin({ workspace: () => "team-2", session: () => SESSION_2 }),
    );
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_OPEN: makeFakeOpen('curl -fsS -X POST "$1" >/dev/null'),
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Waiting for you to log in in the browser... (Ctrl+C to stop)\nLogged in to namespace as team-2 (replaced team-1).\n",
    );
    expect(result.exitCode).toBe(0);
    expect(readSaved(home)).toEqual({
      namespace: {
        way: "browser",
        session: SESSION_2,
        account: "team-2",
        expiresAt: "3000-01-01T00:00:00.000Z",
      },
    });
  });

  it("a browser login when Namespace cannot be reached says to check the network", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe(
      "Could not reach Namespace. Check your network and try again.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(() =>
      statSync(join(home, ".config", "proofbox", "logins.json")),
    ).toThrow();
  });

  it("a browser login with no browser prints the link and keeps waiting", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const run = runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_OPEN: makeFakeOpen("exit 1"),
      },
    });
    await clickWhenWaiting(ns);
    const result = await run;
    // Then
    expect(result.stderr).toBe(
      `Could not open a browser. Open this link on any device: ${iamUrl(ns)}/login/L1\nWaiting for you to log in in the browser... (Ctrl+C to stop)\nLogged in to namespace as team-1.\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("a browser login with no opener installed prints the link", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const run = runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      },
    });
    await clickWhenWaiting(ns);
    const result = await run;
    // Then
    expect(result.stderr).toBe(
      `Could not open a browser. Open this link on any device: ${iamUrl(ns)}/login/L1\nWaiting for you to log in in the browser... (Ctrl+C to stop)\nLogged in to namespace as team-1.\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("a browser login nobody finishes gives up at the login wait", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_OPEN: makeFakeOpen("true"),
        PROOFBOX_LOGIN_WAIT: "1s",
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Waiting for you to log in in the browser... (Ctrl+C to stop)\nThe browser login did not finish in 1s. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
    expect(() => statSync(loginsFile(home))).toThrow();
  });

  it("a login Namespace ends early is asked again", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const signin = fakeSignin();
    let first = true;
    const ns = await fakeNamespaceSignin({
      ...signin,
      answer: (call, base) => {
        if (call.method === "CompleteTenantLogin" && first) {
          first = false;
          return {
            error: { code: "deadline_exceeded", message: "timed out" },
          };
        }
        return signin.answer(call, base);
      },
    });
    // When
    const result = await runCli(env, ["auth", "login", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_OPEN: makeFakeOpen('curl -fsS -X POST "$1" >/dev/null'),
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Waiting for you to log in in the browser... (Ctrl+C to stop)\nLogged in to namespace as team-1.\n",
    );
    expect(result.exitCode).toBe(0);
    expect(
      ns.calls.filter((call) => call.method === "CompleteTenantLogin"),
    ).toHaveLength(2);
  });

  it("a second command reuses the tenant token", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin();
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
    };
    // When
    const first = await runCli(env, ["list"], { set });
    const second = await runCli(env, ["list"], { set });
    // Then
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(
      ns.calls.filter((call) => call.method === "IssueTenantTokenFromSession"),
    ).toHaveLength(1);
    const listed = ns.calls.filter((call) => call.method === "ListInstances");
    expect(listed).toHaveLength(8);
    for (const call of listed) {
      expect(call.authorization).toBe(`Bearer ${TENANT_1}`);
    }
    const files = readdirSync(env.runtime).filter((name) =>
      /^ns-tenant-[0-9a-f]{16}\.json$/.test(name),
    );
    expect(files).toHaveLength(1);
    const tenantFile = files.at(0);
    if (tenantFile === undefined) {
      expect.unreachable("no tenant token file");
    }
    expect(statSync(join(env.runtime, tenantFile)).mode & 0o777).toBe(0o600);
  });

  it("a tenant token near its end is traded again", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin(
      fakeSignin({ tenantToken: tenantTokenEndingIn(60) }),
    );
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
    };
    // When
    const first = await runCli(env, ["list"], { set });
    const second = await runCli(env, ["list"], { set });
    // Then
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(
      ns.calls.filter((call) => call.method === "IssueTenantTokenFromSession"),
    ).toHaveLength(2);
  });

  it("auth status shows the browser login with its region and expiry", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER_EU);
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(env, ["auth", "status"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
      },
    });
    // Then
    expect(result.stdout).toContain(
      "namespace  logged in as team-1, region eu, expires 3000-01-01T00:00:00Z, saved login\n",
    );
    expect(result.exitCode).toBe(0);
    expect(ns.calls).toEqual([]);
  });

  it("create after the browser login expired says to log in again", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER_EXPIRED);
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "namespace"],
      {
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Your Provider login for namespace expired. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
    expect(ns.calls).toEqual([]);
  });

  it("auth logout namespace removes the cached tenant tokens", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin();
    const tenantFile = join(env.runtime, "ns-tenant-0123456789abcdef.json");
    writeFileSync(tenantFile, TENANT_1, { mode: 0o600 });
    // When
    const result = await runCli(env, ["auth", "logout", "namespace"], {
      set: {
        HOME: home,
        PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
      },
    });
    // Then
    expect(result.exitCode).toBe(0);
    expect(
      readdirSync(env.runtime).filter((name) =>
        /^ns-tenant-[0-9a-f]{16}\.json$/.test(name),
      ),
    ).toEqual([]);
    expect(readSaved(home)).toEqual({});
  });

  effectIt.effect("the browser login waits 10 minutes by default", () =>
    Effect.gen(function* () {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      trackTempDir(root);
      const home = makeHome();
      const waiting = yield* Deferred.make<void>();
      const providers = Layer.succeed(
        Providers,
        new Map<string, Provider>([
          [
            "slow",
            {
              ...makeFakeProvider({ root, watch: "none" }),
              name: "slow",
              login: {
                _tag: "Ways",
                checkToken: () => Effect.die("unused"),
                browser: {
                  start: Effect.succeed({
                    loginId: "L1",
                    url: "http://127.0.0.1:9/login/L1",
                  }),
                  complete: () =>
                    Deferred.succeed(waiting, undefined).pipe(
                      Effect.zipRight(Effect.never),
                    ),
                },
              },
            },
          ],
        ]),
      );
      yield* Effect.gen(function* () {
        // When
        const fiber = yield* Effect.fork(
          loginToProvider({
            provider: "slow",
            token: false,
            region: Option.none(),
          }),
        );
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("9 minutes");
        // Then
        const running = yield* Fiber.poll(fiber);
        expect(Option.isNone(running)).toBe(true);
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error.message).toBe(
          "The browser login did not finish in 10m. Run: proofbox auth login slow",
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(CliOutput.Test, providers)),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["HOME", home],
              ["PROOFBOX_OPEN", "true"],
            ]),
          ),
        ),
        Effect.provide(NodeContext.layer),
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

  it("auth token namespace prints the token on stdout and a shown-once note on stderr", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin(undefined, (call) =>
      call.method === "CreateRevokableToken"
        ? { json: { bearerToken: "nsrt_robot_1" } }
        : { json: {} },
    );
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_TOKEN_URL: iamUrl(ns),
    };
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      { set, unset: ["PROOFBOX_NAMESPACE_TOKEN"] },
    );
    // Then
    expect(result.stdout).toBe("nsrt_robot_1\n");
    expect(result.stderr).toBe(
      'Made namespace token "ci". It is shown only this once: store it now.\n',
    );
    expect(result.exitCode).toBe(0);
  });

  it("auth token namespace asks Namespace for a workspace token with only the rights proofbox needs", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin(undefined, (call) =>
      call.method === "CreateRevokableToken"
        ? { json: { bearerToken: "nsrt_robot_1" } }
        : { json: {} },
    );
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_TOKEN_URL: iamUrl(ns),
    };
    // When
    await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      { set, unset: ["PROOFBOX_NAMESPACE_TOKEN"] },
    );
    // Then
    const created = ns.calls.filter(
      (call) => call.method === "CreateRevokableToken",
    );
    expect(created).toHaveLength(1);
    const call = created[0];
    if (call === undefined) {
      expect.unreachable("no CreateRevokableToken call");
    }
    expect(call.region).toBe("");
    expect(call.authorization).toBe(`Bearer ${TENANT_1}`);
    expect(call.body).toEqual({
      name: "ci",
      description: "Made by proofbox auth token",
      expiresAt: expect.any(String),
      access: {
        grants: [
          {
            resourceType: "instance",
            resourceId: "*",
            actions: [
              "create",
              "get",
              "list",
              "wait",
              "refresh",
              "destroy",
              "ssh",
            ],
          },
          {
            resourceType: "containerregistry/image",
            resourceId: "*",
            actions: ["get", "update"],
          },
        ],
      },
    });
  });

  effectIt.effect("auth token sets the expiry --expires after now", () =>
    Effect.gen(function* () {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      trackTempDir(root);
      const home = makeHome(
        '{"robot":{"way":"browser","session":"s1","account":"team-1","expiresAt":"3000-01-01T00:00:00.000Z"}}',
      );
      const requests = yield* Ref.make<ReadonlyArray<TokenRequest>>([]);
      const providers = Layer.succeed(
        Providers,
        new Map<string, Provider>([
          [
            "robot",
            {
              ...makeFakeProvider({ root, watch: "none" }),
              name: "robot",
              login: {
                _tag: "Ways",
                checkToken: () => Effect.die("unused"),
                browser: {
                  start: Effect.succeed({
                    loginId: "L1",
                    url: "http://127.0.0.1:9/login/L1",
                  }),
                  complete: () => Effect.never,
                  makeToken: (_session, request) =>
                    Ref.update(requests, (list) => [...list, request]).pipe(
                      Effect.as(Redacted.make("nsrt_robot_1")),
                    ),
                },
              },
            },
          ],
        ]),
      );
      yield* Effect.gen(function* () {
        // When
        yield* makeRobotToken({
          provider: "robot",
          name: Option.some("ci"),
          expires: Option.some("30d"),
        });
        // Then
        expect(yield* Ref.get(requests)).toEqual([
          { name: "ci", expiresAt: new Date("1970-01-31T00:00:00.000Z") },
        ]);
      }).pipe(
        Effect.provide(Layer.mergeAll(CliOutput.Test, providers)),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["HOME", home]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    }),
  );

  effectIt.effect("auth token reads 1y as 365 days", () =>
    Effect.gen(function* () {
      // Given
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      trackTempDir(root);
      const home = makeHome(
        '{"robot":{"way":"browser","session":"s1","account":"team-1","expiresAt":"3000-01-01T00:00:00.000Z"}}',
      );
      const requests = yield* Ref.make<ReadonlyArray<TokenRequest>>([]);
      const providers = Layer.succeed(
        Providers,
        new Map<string, Provider>([
          [
            "robot",
            {
              ...makeFakeProvider({ root, watch: "none" }),
              name: "robot",
              login: {
                _tag: "Ways",
                checkToken: () => Effect.die("unused"),
                browser: {
                  start: Effect.succeed({
                    loginId: "L1",
                    url: "http://127.0.0.1:9/login/L1",
                  }),
                  complete: () => Effect.never,
                  makeToken: (_session, request) =>
                    Ref.update(requests, (list) => [...list, request]).pipe(
                      Effect.as(Redacted.make("nsrt_robot_1")),
                    ),
                },
              },
            },
          ],
        ]),
      );
      yield* Effect.gen(function* () {
        // When
        yield* makeRobotToken({
          provider: "robot",
          name: Option.some("ci"),
          expires: Option.some("1y"),
        });
        // Then
        expect(yield* Ref.get(requests)).toEqual([
          { name: "ci", expiresAt: new Date("1971-01-01T00:00:00.000Z") },
        ]);
      }).pipe(
        Effect.provide(Layer.mergeAll(CliOutput.Test, providers)),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["HOME", home]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    }),
  );

  it("auth token namespace with only the env token says to log in", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      {
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
          PROOFBOX_NAMESPACE_TOKEN_URL: iamUrl(ns),
          PROOFBOX_NAMESPACE_TOKEN: TOKEN,
        },
      },
    );
    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Not logged in to namespace. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
    expect(ns.calls).toEqual([]);
  });

  it("auth token namespace with no login says to log in", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      { set: { HOME: home }, unset: ["PROOFBOX_NAMESPACE_TOKEN"] },
    );
    // Then
    expect(result.stderr).toBe(
      "Not logged in to namespace. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace when Namespace cannot be reached says to check the network", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin();
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      {
        set: {
          HOME: home,
          PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
          PROOFBOX_NAMESPACE_TOKEN_URL: "http://127.0.0.1:9",
        },
        unset: ["PROOFBOX_NAMESPACE_TOKEN"],
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Could not reach Namespace. Check your network and try again.\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token fake says fake cannot make tokens", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(
      env,
      ["auth", "token", "fake", "--name", "ci", "--expires", "30d"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe("fake cannot make tokens.\n");
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace without --expires says it is required", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe(
      "--expires is required (for example 30d, at most 1y).\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace --expires over one year gives the limit", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "366d"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe(
      "--expires is required (for example 30d, at most 1y).\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace with an --expires it cannot read gives the limit", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30x"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe(
      "--expires is required (for example 30d, at most 1y).\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace without --name says it is required", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--expires", "30d"],
      { set: { HOME: home } },
    );
    // Then
    expect(result.stderr).toBe("--name is required (for example ci).\n");
    expect(result.exitCode).toBe(125);
  });

  it("auth token docker says docker needs no login", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["auth", "token", "docker"], {
      set: { HOME: home },
    });
    // Then
    expect(result.stderr).toBe("docker needs no login.\n");
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace without the right to make tokens says to ask an admin", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin(undefined, (call) =>
      call.method === "CreateRevokableToken"
        ? { error: { code: "permission_denied", message: "denied" } }
        : { json: {} },
    );
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_TOKEN_URL: iamUrl(ns),
    };
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      { set, unset: ["PROOFBOX_NAMESPACE_TOKEN"] },
    );
    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Your Namespace account cannot make tokens. Ask a workspace admin.\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("auth token namespace with a session Namespace refuses says the login expired", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome(NS_BROWSER);
    const ns = await fakeNamespaceSignin(undefined, (call) =>
      call.method === "CreateRevokableToken"
        ? { error: { code: "unauthenticated", message: "bad token" } }
        : { json: {} },
    );
    const set = {
      HOME: home,
      PROOFBOX_NAMESPACE_IAM_URL: iamUrl(ns),
      PROOFBOX_NAMESPACE_TOKEN_URL: iamUrl(ns),
    };
    // When
    const result = await runCli(
      env,
      ["auth", "token", "namespace", "--name", "ci", "--expires", "30d"],
      { set, unset: ["PROOFBOX_NAMESPACE_TOKEN"] },
    );
    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Your Provider login for namespace expired. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
  });
});
