import { Effect, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { UnknownProviderError } from "../errors.ts";
import { Providers } from "../provider.ts";

export const execInSandbox = (rawId: string, argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const separator = rawId.indexOf(":");
    const providerName = separator < 0 ? rawId : rawId.slice(0, separator);
    const name = separator < 0 ? "" : rawId.slice(separator + 1);
    const provider = providers.get(providerName);
    if (provider === undefined) {
      return yield* new UnknownProviderError({
        provider: providerName,
        known: [...providers.keys()],
      });
    }
    const output = yield* CliOutput;
    const connection = yield* provider.connect(name);
    yield* connection.exec(argv).pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout":
            return output.out(event.bytes);
          case "Stderr":
            return output.err(event.bytes);
          case "Exit":
            return output.setExitCode(event.code);
        }
      }),
    );
  }).pipe(Effect.scoped);
