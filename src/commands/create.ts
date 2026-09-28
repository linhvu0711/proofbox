import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { idleDefault, MAX_LIFE_DEFAULT, parseSpan } from "../deadline.ts";
import { MissingCapabilityError, UnknownProviderError } from "../errors.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Progress } from "../progress.ts";
import { type Os, Providers } from "../provider.ts";

export const createSandbox = (options: {
  readonly os: Os;
  readonly provider: string;
  readonly idle?: string | undefined;
  readonly maxLife?: string | undefined;
}) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const provider = providers.get(options.provider);
    if (provider === undefined) {
      return yield* new UnknownProviderError({
        provider: options.provider,
        known: [...providers.keys()],
      });
    }
    const capability = `os:${options.os}` as const;
    if (!provider.capabilities.has(capability)) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability,
      });
    }
    const idle =
      options.idle === undefined
        ? idleDefault(options.os)
        : yield* parseSpan("idle", options.idle);
    const maxLife =
      options.maxLife === undefined
        ? MAX_LIFE_DEFAULT
        : yield* parseSpan("max-life", options.maxLife);
    const info = yield* provider.create({
      os: options.os,
      idle,
      maxLife,
    });
    const output = yield* CliOutput;
    const id = `${provider.name}:${info.name}`;
    const keeper = yield* KeeperClient;
    const progress = yield* Progress;
    yield* progress
      .step("starting Keeper", keeper.start(id))
      .pipe(
        Effect.catchAll(() =>
          output.err(
            "proofbox: Keeper did not start; commands still work, only slower\n",
          ),
        ),
      );
    yield* output.out(`${id}\n`);
  });
