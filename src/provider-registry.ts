import { CommandExecutor } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import { makeDockerClient } from "./docker/docker-client.ts";
import { makeDockerProvider } from "./docker/docker-provider.ts";
import { ProviderError } from "./errors.ts";
import { type Provider, Providers } from "./provider.ts";

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const providers = new Map<string, Provider>([
      ["docker", makeDockerProvider({ client: makeDockerClient(executor) })],
    ]);
    const fakeRoot = yield* Config.option(Config.string("PROOFBOX_FAKE_ROOT"));
    if (Option.isSome(fakeRoot)) {
      const fake = yield* Effect.tryPromise({
        try: () => import("./fake/fake-provider.ts"),
        catch: (cause) =>
          new ProviderError({ provider: "fake", reason: String(cause) }),
      });
      providers.set(
        "fake",
        fake.makeFakeProvider({ root: fakeRoot.value, watch: "process" }),
      );
    }
    return providers;
  }),
);
