import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";

export const deleteSandbox = (rawId: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const parsed = yield* resolveSandboxId(rawId, providers);
    const provider = parsed.provider;
    const result = yield* provider.delete(parsed.name);
    const keeper = yield* KeeperClient;
    yield* keeper.stop(rawId);
    yield* output.out(
      result === "deleted"
        ? `Deleted ${parsed.prefix}:${parsed.name}\n`
        : `Sandbox ${parsed.prefix}:${parsed.name} is already gone\n`,
    );
  });
