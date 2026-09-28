import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { idleDefault, MAX_LIFE_DEFAULT, parseSpan } from "../deadline.ts";
import {
  MissingCapabilityError,
  SizeNotOfferedError,
  UnknownProviderError,
} from "../errors.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Progress } from "../progress.ts";
import { type Os, Providers } from "../provider.ts";
import { formatSize, parseSize } from "../size.ts";

export const createSandbox = (options: {
  readonly os: Os;
  readonly provider: string;
  readonly idle?: string | undefined;
  readonly maxLife?: string | undefined;
  readonly size?: string | undefined;
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
    const size =
      options.size === undefined ? undefined : yield* parseSize(options.size);
    if (size !== undefined && provider.sizes !== "any") {
      const offered = provider.sizes.some(
        (listed) => listed.cpu === size.cpu && listed.ramGb === size.ramGb,
      );
      if (!offered) {
        return yield* new SizeNotOfferedError({
          provider: provider.name,
          size: formatSize(size),
          offered: provider.sizes.map(formatSize),
        });
      }
    }
    const info = yield* provider.create({
      os: options.os,
      idle,
      maxLife,
      size,
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
