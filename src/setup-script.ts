import { Effect } from "effect";
import { CliOutput } from "./cli-output.ts";
import { runKeepingTail } from "./command-tail.ts";
import { withDeadlinePush } from "./deadline.ts";
import { SetupScriptFailedError, UploadFailedError } from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { sandboxFiles, writeSandboxFile } from "./sandbox-file.ts";
import { resolveSandboxId } from "./sandbox-id.ts";

export const runSetupScript = Effect.fn("setupScript.runSetupScript")(
  function* (rawId: string, script: Uint8Array) {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const info = yield* provider.get(id);
    const progress = yield* Progress;
    const keeper = yield* KeeperClient;
    const setupPath = sandboxFiles(provider, id.name, info.os).setupScript;
    const result = yield* progress.step(
      "running Setup script",
      withDeadlinePush(
        provider,
        id,
        info,
      )(
        Effect.gen(function* () {
          const writeCode = yield* writeSandboxFile(rawId, setupPath, script, {
            executable: true,
          });
          if (writeCode !== 0) {
            return yield* new UploadFailedError({
              id: rawId,
              command: "sh",
              code: writeCode,
            });
          }
          return yield* runKeepingTail(rawId, [setupPath]);
        }),
      ),
    );
    if (result.code !== 0) {
      const output = yield* CliOutput;
      for (const line of result.lines) {
        yield* output.err(line);
      }
      yield* provider.delete(id);
      yield* keeper.stop(rawId);
      return yield* new SetupScriptFailedError({ code: result.code });
    }
  },
);
