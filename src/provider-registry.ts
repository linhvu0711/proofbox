import { CommandExecutor } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import { makeDockerClient } from "./docker/docker-client.ts";
import { makeDockerProvider } from "./docker/docker-provider.ts";
import { ProviderError } from "./errors.ts";
import { loginFor } from "./login/provider-login.ts";
import { makeNamespaceApi } from "./namespace/namespace-api.ts";
import { namespaceLogin } from "./namespace/namespace-login.ts";
import { makeNamespaceProvider } from "./namespace/namespace-provider.ts";
import { makeOpenLink, makeSshForward } from "./namespace/ssh-link.ts";
import { type Provider, Providers } from "./provider.ts";
import { spawnDetached } from "./spawn-detached.ts";

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const namespaceApi = makeNamespaceApi({ login: namespaceLogin });
    const providers = new Map<string, Provider>([
      ["docker", makeDockerProvider({ client: makeDockerClient(executor) })],
      [
        "namespace",
        makeNamespaceProvider({
          api: namespaceApi,
          login: namespaceLogin,
          openLink: makeOpenLink(namespaceApi, executor),
          forward: makeSshForward(namespaceApi, executor),
          dockerFor: (link) => makeDockerClient(executor, { ssh: link.ssh }),
          spawnDetached,
        }),
      ],
    ]);
    const fakeRoot = yield* Config.option(Config.string("PROOFBOX_FAKE_ROOT"));
    if (Option.isSome(fakeRoot)) {
      const fake = yield* Effect.tryPromise({
        try: () => import("./fake/fake-provider.ts"),
        catch: (cause) =>
          new ProviderError({ provider: "fake", reason: String(cause) }),
      });
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
      providers.set(
        "fake",
        fake.makeFakeProvider({
          root: fakeRoot.value,
          watch: "process",
          login: loginFor("fake"),
          marksLocal: true,
          unreached: Option.getOrUndefined(unreached),
          listDown: Option.getOrUndefined(listDown),
          deleteDown: Option.getOrUndefined(deleteDown),
          snapshots: Option.isSome(snapshotsRoot)
            ? {
                root: snapshotsRoot.value,
                fail: Option.getOrUndefined(snapshotFail),
              }
            : undefined,
        }),
      );
    }
    return providers;
  }),
);
