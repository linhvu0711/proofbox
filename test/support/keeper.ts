import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, TestServices } from "effect";
import { CliOutput } from "../../src/cli-output.ts";
import { runKeeper } from "../../src/keeper/keeper.ts";
import { KeeperClient } from "../../src/keeper/keeper-client.ts";
import { keeperAnswers } from "../../src/keeper/lifecycle.ts";
import { keeperPaths } from "../../src/keeper/paths.ts";
import {
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../../src/provider.ts";
import { fileStem, resolveSandboxId } from "../../src/sandbox-id.ts";

// The layers a command needs to reach the Keeper of a Sandbox of
// `provider`: the CLI side, with that one Provider, so a test can count
// what the CLI asks of it.
export const keeperClientLayers = (provider: Provider) =>
  KeeperClient.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CliOutput.Test,
        Layer.succeed(
          Providers,
          new Map<string, ProviderEntry>([
            [provider.name, providerEntry(provider)],
          ]),
        ),
        NodeContext.layer,
      ),
    ),
  );

// Runs the Keeper of Sandbox `id` in this process, in the test's scope,
// and waits until its socket answers. Gives the layers of
// `keeperClientLayers`. Needs PROOFBOX_RUNTIME_DIR in the config.
export const startKeeper = (id: string, provider: Provider) =>
  Effect.gen(function* () {
    const providers = Layer.succeed(
      Providers,
      new Map<string, ProviderEntry>([
        [provider.name, providerEntry(provider)],
      ]),
    );
    yield* Effect.forkScoped(
      runKeeper(id).pipe(
        Effect.provide(Layer.merge(providers, NodeContext.layer)),
      ),
    );
    const resolved = yield* resolveSandboxId(
      id,
      new Map([[provider.name, providerEntry(provider)]]),
    );
    const socket = (yield* keeperPaths({
      provider: resolved.prefix,
      name: fileStem(resolved),
    })).socket;
    for (let i = 0; i < 250 && !(yield* keeperAnswers(socket)); i++) {
      yield* TestServices.provideLive(Effect.sleep("20 millis"));
    }
    return keeperClientLayers(provider);
  });

// Waits, on the real clock, until `check` holds or about 5 s pass.
export const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 250 && !(yield* check); i++) {
      yield* TestServices.provideLive(Effect.sleep("20 millis"));
    }
  });
