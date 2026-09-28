import { Effect, Option } from "effect";
import { CliOutput } from "../cli-output.ts";
import { idleDefault, MAX_LIFE_DEFAULT, parseSpan } from "../deadline.ts";
import { UnknownProviderError } from "../errors.ts";
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
    yield* output.out(`${provider.name}:${info.name}\n`);
  });
