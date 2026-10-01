import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { formatSandboxId, resolveSandboxId } from "../sandbox-id.ts";

export const deleteSandbox = Effect.fn("delete.deleteSandbox")(function* (
  rawId: string,
) {
  const providers = yield* Providers;
  const output = yield* CliOutput;
  const parsed = yield* resolveSandboxId(rawId, providers);
  const provider = parsed.provider;
  const result = yield* provider.delete(parsed);
  const keeper = yield* KeeperClient;
  yield* keeper.stop(rawId);
  const id = formatSandboxId({
    provider: parsed.prefix,
    region: parsed.region,
    name: parsed.name,
  });
  yield* output.out(
    result === "deleted"
      ? `Deleted ${id}\n`
      : `Sandbox ${id} is already gone\n`,
  );
});
