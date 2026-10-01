import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeNamespaceApi } from "../src/namespace/namespace-api.ts";
import { cleanupEnvs } from "./support/cli.ts";
import {
  type FakeNamespace,
  startFakeNamespace,
  TENANT_1,
} from "./support/fake-namespace-api.ts";

const servers: FakeNamespace[] = [];

const fakeNamespace = async (
  answer: Parameters<typeof startFakeNamespace>[0],
) => {
  const server = await startFakeNamespace(answer);
  servers.push(server);
  return server;
};

// A login already made, as `makeNamespaceApi` sees one.
const login = Effect.succeed({
  token: Redacted.make(TENANT_1),
  region: Option.some("us"),
});

// The fake's Registry base: its url without the `/{region}` tail, since
// the global Registry has no region.
const registryUrl = (server: FakeNamespace) =>
  server.url.replace("/{region}", "");

const config = (server: FakeNamespace) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(
      new Map([["PROOFBOX_NAMESPACE_REGISTRY_URL", registryUrl(server)]]),
    ),
  );

describe("Namespace API", () => {
  afterEach(async () => {
    cleanupEnvs();
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it.effect(
    "ensureImageExpiry asks the Registry to keep the image at least 336 hours",
    () =>
      Effect.gen(function* () {
        // Given
        const ns = yield* Effect.promise(() =>
          fakeNamespace((call) =>
            call.method === "UpdateImageLifetime"
              ? { json: { newExpiry: "2026-10-14T12:00:00Z" } }
              : { json: {} },
          ),
        );
        // When
        yield* makeNamespaceApi({ login })
          .ensureImageExpiry("proofbox-snapshot-linux@sha256:ab12", 336)
          .pipe(config(ns));
        // Then
        expect(ns.calls).toEqual([
          {
            region: "",
            method: "UpdateImageLifetime",
            body: {
              repository: "proofbox-snapshot-linux",
              digest: "sha256:ab12",
              ensureMinimumRemaining: "1209600s",
            },
            authorization: `Bearer ${TENANT_1}`,
          },
        ]);
      }),
  );

  it.effect(
    "ensureImageExpiry with a token that cannot update images names the permission",
    () =>
      Effect.gen(function* () {
        // Given
        const ns = yield* Effect.promise(() =>
          fakeNamespace((call) =>
            call.method === "UpdateImageLifetime"
              ? { error: { code: "permission_denied", message: "denied" } }
              : { json: {} },
          ),
        );
        // When
        const error = yield* makeNamespaceApi({ login })
          .ensureImageExpiry("proofbox-snapshot-linux@sha256:ab12", 336)
          .pipe(config(ns), Effect.flip);
        // Then
        expect(error.message).toBe(
          "This Namespace token lacks permission for ContainerRegistryService.UpdateImageLifetime. Use a token that can update registry images.",
        );
      }),
  );

  it.effect(
    "list gives when each instance started and whether Namespace still makes it",
    () =>
      Effect.gen(function* () {
        // Given: one instance Namespace still creates and one running
        const ns = yield* Effect.promise(() =>
          fakeNamespace((call) =>
            call.method === "ListInstances"
              ? {
                  json: {
                    instances: [
                      {
                        instanceId: "mac000000000a",
                        status: "CREATING",
                        createdAt: "2026-10-01T07:49:00Z",
                      },
                      {
                        instanceId: "lin000000000a",
                        status: "RUNNING",
                        createdAt: "2026-10-01T07:40:00Z",
                      },
                    ],
                  },
                }
              : { json: {} },
          ),
        );
        // When
        const listed = yield* makeNamespaceApi({ login })
          .list("us", [])
          .pipe(
            Effect.withConfigProvider(
              ConfigProvider.fromMap(
                new Map([["PROOFBOX_NAMESPACE_COMPUTE_URL", ns.url]]),
              ),
            ),
          );
        // Then
        expect(
          listed.map(({ id, createdAt, starting }) => ({
            id,
            createdAt,
            starting,
          })),
        ).toEqual([
          {
            id: "mac000000000a",
            createdAt: new Date("2026-10-01T07:49:00Z"),
            starting: true,
          },
          {
            id: "lin000000000a",
            createdAt: new Date("2026-10-01T07:40:00Z"),
            starting: false,
          },
        ]);
      }),
  );
});
