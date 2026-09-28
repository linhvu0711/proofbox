import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { UnknownProviderError } from "../errors.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";

export const deleteSandbox = (rawId: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const parsed = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(parsed.provider);
    if (provider === undefined) {
      return yield* new UnknownProviderError({
        provider: parsed.provider,
        known: [...providers.keys()],
      });
    }
    const result = yield* provider.delete(parsed.name);
    const keeper = yield* KeeperClient;
    yield* keeper.stop(rawId);
    yield* output.out(
      result === "deleted"
        ? `Deleted ${parsed.provider}:${parsed.name}\n`
        : `Sandbox ${parsed.provider}:${parsed.name} is already gone\n`,
    );
  });
