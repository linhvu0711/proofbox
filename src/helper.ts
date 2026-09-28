import { Effect, Stream } from "effect";
import { withDeadlinePush } from "./deadline.ts";
import { MissingCapabilityError } from "./errors.ts";
import {
  KeeperClient,
  type KeeperExecOptions,
} from "./keeper/keeper-client.ts";
import { type Os, Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

export const runHelper = (
  rawId: string,
  helpers: Partial<Record<Os, string>>,
  argv: ReadonlyArray<string>,
  options: {
    readonly outcome: string;
    readonly stdin?: KeeperExecOptions["stdin"];
  },
) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    if (!provider.capabilities.has("desktop")) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "desktop",
        outcome: options.outcome,
      });
    }
    const info = yield* provider.get(id.name);
    const helper = helpers[info.os];
    if (helper === undefined) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "desktop",
        outcome: options.outcome,
      });
    }
    const keeper = yield* KeeperClient;
    const collected = yield* withDeadlinePush(
      provider,
      id.name,
      info,
    )(
      Effect.gen(function* () {
        const events = yield* keeper.exec(
          rawId,
          [helper, ...argv],
          options.stdin === undefined ? undefined : { stdin: options.stdin },
        );
        return yield* events.pipe(
          Stream.runFold(
            {
              stdout: [] as Uint8Array[],
              stderr: [] as Uint8Array[],
              code: undefined as number | undefined,
            },
            (acc, event) => {
              switch (event._tag) {
                case "Stdout":
                  acc.stdout.push(event.bytes);
                  return acc;
                case "Stderr":
                  acc.stderr.push(event.bytes);
                  return acc;
                case "Exit":
                  return { ...acc, code: event.code };
              }
            },
          ),
        );
      }),
    );
    return {
      provider: id.provider,
      code: collected.code,
      stdout: Buffer.concat(collected.stdout),
      stderr: Buffer.concat(collected.stderr).toString("utf8").trim(),
    };
  });
