import { CommandExecutor, FileSystem } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import { ProviderError } from "./errors.ts";
import { loginFor } from "./login/provider-login.ts";
import { type ProviderEntry, Providers } from "./provider.ts";
import { spawnDetached } from "./spawn-detached.ts";

// Each Provider's code, and the libraries it needs, loads only when a
// command first asks for that Provider.
const importFor = Effect.fn("providerRegistry.importFor")(
  <A>(provider: string, load: () => Promise<A>) =>
    Effect.tryPromise({
      try: load,
      catch: (cause) => new ProviderError({ provider, reason: String(cause) }),
    }),
);

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;
    const docker = yield* Effect.cached(
      importFor("docker", () =>
        Promise.all([
          import("./docker/docker-client.ts"),
          import("./docker/docker-provider.ts"),
        ]),
      ).pipe(
        Effect.map(([client, provider]) =>
          provider.makeDockerProvider({
            client: client.makeDockerClient(executor),
          }),
        ),
      ),
    );
    const namespace = yield* Effect.cached(
      importFor("namespace", () =>
        Promise.all([
          import("./docker/docker-client.ts"),
          import("./namespace/namespace-api.ts"),
          import("./namespace/namespace-login.ts"),
          import("./namespace/namespace-provider.ts"),
          import("./namespace/ssh-link.ts"),
        ]),
      ).pipe(
        Effect.map(([client, api, login, provider, link]) => {
          const namespaceLogin = login.makeNamespaceLogin(fs);
          const namespaceApi = api.makeNamespaceApi({ login: namespaceLogin });
          return provider.makeNamespaceProvider({
            api: namespaceApi,
            executor,
            login: namespaceLogin,
            openLink: link.makeOpenLink(namespaceApi, executor),
            forward: link.makeSshForward(namespaceApi, executor, fs),
            fs,
            dockerFor: (sandbox) =>
              client.makeDockerClient(executor, { ssh: sandbox.ssh }),
            spawnDetached,
          });
        }),
      ),
    );
    const providers = new Map<string, ProviderEntry>([
      ["docker", { name: "docker", idPrefix: "docker", load: docker }],
      ["namespace", { name: "namespace", idPrefix: "ns", load: namespace }],
    ]);
    const fakeRoot = yield* Config.option(Config.string("PROOFBOX_FAKE_ROOT"));
    if (Option.isSome(fakeRoot)) {
      const snapshotsRoot = yield* Config.option(
        Config.string("PROOFBOX_FAKE_SNAPSHOTS"),
      );
      const snapshotFail = yield* Config.option(
        Config.literal("push", "pull")("PROOFBOX_FAKE_SNAPSHOT_FAIL"),
      );
      const unreached = yield* Config.option(
        Config.string("PROOFBOX_FAKE_UNREACHED"),
      );
      const listDown = yield* Config.option(
        Config.string("PROOFBOX_FAKE_LIST_DOWN"),
      );
      const deleteDown = yield* Config.option(
        Config.string("PROOFBOX_FAKE_DELETE_DOWN"),
      );
      const createHold = yield* Config.option(
        Config.string("PROOFBOX_FAKE_CREATE_HOLD"),
      );
      const fake = yield* Effect.cached(
        importFor("fake", () => import("./fake/fake-provider.ts")).pipe(
          Effect.map((module) =>
            module.makeFakeProvider({
              fs,
              root: fakeRoot.value,
              watch: "process",
              login: loginFor("fake").pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
              marksLocal: true,
              unreached: Option.getOrUndefined(unreached),
              listDown: Option.getOrUndefined(listDown),
              deleteDown: Option.getOrUndefined(deleteDown),
              createHold: Option.getOrUndefined(createHold),
              snapshots: Option.isSome(snapshotsRoot)
                ? {
                    root: snapshotsRoot.value,
                    fail: Option.getOrUndefined(snapshotFail),
                  }
                : undefined,
            }),
          ),
        ),
      );
      providers.set("fake", { name: "fake", idPrefix: "fake", load: fake });
    }
    return providers;
  }),
);
