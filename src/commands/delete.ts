import { Effect, Option } from "effect";
import { CliOutput } from "../cli-output.ts";
import { Harnesses } from "../harness.ts";
import { saveBackHarnessLoginFile } from "../harness-sandbox.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { formatSandboxId, resolveSandboxId } from "../sandbox-id.ts";
import { runTurnScript, turnFiles } from "../turn.ts";

export const deleteSandbox = Effect.fn("delete.deleteSandbox")(function* (
  rawId: string,
) {
  const providers = yield* Providers;
  const output = yield* CliOutput;
  const parsed = yield* resolveSandboxId(rawId, providers);
  const provider = parsed.provider;
  if (Option.isSome(yield* Effect.option(provider.get(parsed)))) {
    const name = yield* Effect.option(
      Effect.gen(function* () {
        const files = yield* turnFiles(rawId);
        return yield* runTurnScript(rawId, [
          "sh",
          "-c",
          'head -n 1 "$1" 2>/dev/null',
          "sh",
          files.harness,
        ]);
      }),
    );
    if (Option.isSome(name) && name.value.code === 0) {
      const harnesses = yield* Harnesses;
      const entry = harnesses.get(name.value.out.trim());
      if (entry?.login._tag === "File") {
        yield* saveBackHarnessLoginFile(rawId, entry).pipe(
          Effect.catchAll((error) =>
            output.err(
              `proofbox: could not save the renewed Harness login back (${error.message})\n`,
            ),
          ),
        );
      }
    }
  }
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
}, Effect.scoped);
