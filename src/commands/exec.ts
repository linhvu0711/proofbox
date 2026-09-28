import { Effect, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { withDeadlinePush } from "../deadline.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
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
    const output = yield* CliOutput;
    const info = yield* provider.get(id.name);
    const keeper = yield* KeeperClient;
    const events = yield* keeper.exec(rawId, argv);
    yield* withDeadlinePush(
      provider,
      id.name,
      info,
    )(
      events.pipe(
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
      ),
    );
  }).pipe(Effect.scoped);
