import { Clock, Duration, Effect, Schedule, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { nextDeadline } from "../deadline.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";
import { OUT_OF_MEMORY_EXIT, outOfMemoryMessage } from "../size.ts";

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
    const idle = Duration.seconds(info.idleSeconds);
    const push = Effect.flatMap(Clock.currentTimeMillis, (millis) =>
      provider.extend(
        id.name,
        nextDeadline({
          now: new Date(millis),
          idle,
          maxLifeAt: info.maxLifeAt,
        }),
      ),
    );
    yield* push;
    const killsBefore = yield* provider.memoryKills(id.name);
    const keeper = yield* KeeperClient;
    const events = yield* keeper.exec(rawId, argv);
    const pushWhileRunning = Effect.repeat(
      push,
      Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
    );
    let exitCode: number | undefined;
    yield* events.pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout":
            return output.out(event.bytes);
          case "Stderr":
            return output.err(event.bytes);
          case "Exit":
            exitCode = event.code;
            return output.setExitCode(event.code);
        }
      }),
      Effect.raceFirst(pushWhileRunning),
    );
    const killsAfter = yield* provider.memoryKills(id.name);
    // The kill count is container-wide; a new kill plus a clean or 137 exit
    // means the command hid an OOM child (e.g. an early pipeline stage).
    if (killsAfter > killsBefore && (exitCode === 0 || exitCode === 137)) {
      yield* output.err(`${outOfMemoryMessage(info.size, provider.sizes)}\n`);
      yield* output.setExitCode(OUT_OF_MEMORY_EXIT);
    }
    yield* push;
  }).pipe(Effect.scoped);
