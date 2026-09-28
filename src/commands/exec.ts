import { Effect, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";

export const execInSandbox = (rawId: string, argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    yield* provider.get(id.name);
    const output = yield* CliOutput;
    const connection = yield* provider.connect(id.name);
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
