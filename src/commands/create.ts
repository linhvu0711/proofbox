import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { UnknownProviderError } from "../errors.ts";
import { type Os, Providers } from "../provider.ts";

export const createSandbox = (options: {
  readonly os: Os;
  readonly provider: string;
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
    const info = yield* provider.create({ os: options.os });
    const output = yield* CliOutput;
    yield* output.out(`${provider.name}:${info.name}\n`);
  });
