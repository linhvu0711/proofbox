import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted, TestClock } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeNamespaceApi } from "../src/namespace/namespace-api.ts";
import { makeNamespaceLogin } from "../src/namespace/namespace-login.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";
import {
  EXPIRED_TENANT_1,
  type FakeNamespace,
  type FakeSignin,
  fakeSignin,
  SESSION_1,
  startFakeNamespace,
  TENANT_1,
  TENANT_2,
  toSnakeKeys,
} from "./support/fake-namespace-api.ts";
import { nodeFileSystem } from "./support/node-file-system.ts";

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-login-"));
  trackTempDir(dir);
  return dir;
};

// A HOME whose logins.json holds the slice's browser slot.
const homeWithLogin = (region?: string): string => {
  const home = tempDir();
  const dir = join(home, ".config", "proofbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "logins.json"),
    `${JSON.stringify({
      namespace: {
        way: "browser",
        session: SESSION_1,
        account: "team-1",
        expiresAt: "3000-01-01T00:00:00.000Z",
        ...(region === undefined ? {} : { region }),
      },
    })}\n`,
    { mode: 0o600 },
  );
  return home;
};

const servers: FakeNamespace[] = [];

const fakeNamespace = async (
  signin?: FakeSignin,
  answer: Parameters<typeof startFakeNamespace>[0] = () => ({ json: {} }),
) => {
  const server = await startFakeNamespace(answer, 0, signin);
  servers.push(server);
  return server;
};

// The fake's IAM base: its url without the `/{region}` tail.
const iamUrl = (server: FakeNamespace) => server.url.replace("/{region}", "");

const config = (home: string, runtime: string, server: FakeNamespace) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["HOME", home],
        ["PROOFBOX_RUNTIME_DIR", runtime],
        ["PROOFBOX_NAMESPACE_IAM_URL", iamUrl(server)],
        ["PROOFBOX_NAMESPACE_COMPUTE_URL", server.url],
      ]),
    ),
  );

describe("Namespace login", () => {
  afterEach(async () => {
    cleanupEnvs();
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it.effect(
    "a saved browser login creates with a tenant token, never the session",
    () =>
      Effect.gen(function* () {
        // Given
        const home = homeWithLogin();
        const runtime = tempDir();
        const ns = yield* Effect.promise(() =>
          fakeNamespace(fakeSignin(), (call) =>
            call.method === "CreateInstance"
              ? { json: { metadata: { instanceId: "i-1" } } }
              : { json: {} },
          ),
        );
        const api = makeNamespaceApi({
          login: makeNamespaceLogin(nodeFileSystem),
        });
        // When
        const made = yield* api
          .create("us", {
            shape: {
              os: "linux",
              machineArch: "amd64",
              virtualCpu: 4,
              memoryMegabytes: 8192,
              selectors: [],
            },
            labels: [],
            deadline: new Date("2999-01-01T00:00:00.000Z"),
            authorizedSshKeys: [],
          })
          .pipe(config(home, runtime, ns));
        // Then
        expect(made).toBe("i-1");
        expect(ns.calls).toHaveLength(2);
        expect(ns.calls[0]).toEqual({
          region: "",
          method: "IssueTenantTokenFromSession",
          body: toSnakeKeys({ tokenDurationSecs: 3600 }),
          authorization: `Bearer ${SESSION_1}`,
        });
        expect(ns.calls[1]).toMatchObject({
          region: "us",
          method: "CreateInstance",
          authorization: `Bearer ${TENANT_1}`,
        });
        for (const call of ns.calls.slice(1)) {
          expect(JSON.stringify(call.body)).not.toContain(SESSION_1);
          expect(call.authorization ?? "").not.toContain(SESSION_1);
        }
      }),
  );

  it.effect("a saved browser login in eu hands over region eu", () =>
    Effect.gen(function* () {
      // Given
      const home = homeWithLogin("eu");
      const runtime = tempDir();
      const ns = yield* Effect.promise(() => fakeNamespace(fakeSignin()));
      // When
      const hand = yield* makeNamespaceLogin(nodeFileSystem).pipe(
        config(home, runtime, ns),
      );
      // Then
      expect(Redacted.value(hand.token)).toBe(TENANT_1);
      expect(Option.getOrNull(hand.region)).toBe("eu");
    }),
  );

  it.effect("a tenant token past its expiry is traded again, not reused", () =>
    Effect.gen(function* () {
      // Given
      const home = homeWithLogin();
      const runtime = tempDir();
      const signin = fakeSignin();
      const tokens = [EXPIRED_TENANT_1, TENANT_2];
      const ns = yield* Effect.promise(() =>
        fakeNamespace({
          ...signin,
          answer: (call, base) =>
            call.method === "IssueTenantTokenFromSession"
              ? {
                  json: toSnakeKeys({
                    tenantToken: tokens.shift() ?? TENANT_2,
                  }),
                }
              : signin.answer(call, base),
        }),
      );
      // When
      const first = yield* makeNamespaceLogin(nodeFileSystem).pipe(
        config(home, runtime, ns),
      );
      yield* TestClock.adjust("2 minutes");
      const second = yield* makeNamespaceLogin(nodeFileSystem).pipe(
        config(home, runtime, ns),
      );
      // Then
      expect(Redacted.value(first.token)).toBe(EXPIRED_TENANT_1);
      expect(Redacted.value(second.token)).toBe(TENANT_2);
      expect(ns.calls.map((call) => call.method)).toEqual([
        "IssueTenantTokenFromSession",
        "IssueTenantTokenFromSession",
      ]);
    }),
  );

  it.effect("a session Namespace refuses reads as an expired login", () =>
    Effect.gen(function* () {
      // Given
      const home = homeWithLogin();
      const runtime = tempDir();
      const signin = fakeSignin();
      const ns = yield* Effect.promise(() =>
        fakeNamespace({
          ...signin,
          answer: (call, base) =>
            call.method === "IssueTenantTokenFromSession"
              ? {
                  error: {
                    code: "unauthenticated",
                    message: "bad session",
                  },
                }
              : signin.answer(call, base),
        }),
      );
      // When
      const error = yield* makeNamespaceLogin(nodeFileSystem).pipe(
        config(home, runtime, ns),
        Effect.flip,
      );
      // Then
      expect(error.message).toBe(
        "Your Provider login for namespace expired. Run: proofbox auth login namespace",
      );
    }),
  );
});
