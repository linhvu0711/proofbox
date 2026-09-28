import { Config, Effect, Layer, Option } from "effect";
import { ProviderError } from "./errors.ts";
import { type Provider, Providers } from "./provider.ts";

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const providers = new Map<string, Provider>();
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
