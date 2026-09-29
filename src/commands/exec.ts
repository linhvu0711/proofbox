import { posix } from "node:path";
import { Duration, Effect, Schedule, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { deadlinePush } from "../deadline.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";
import { withSecrets } from "../secrets.ts";
import { OUT_OF_MEMORY_EXIT, outOfMemoryMessage } from "../size.ts";

export const execInSandbox = (rawId: string, argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const output = yield* CliOutput;
    const [info, killsBefore] = yield* Effect.all(
      [provider.get(id.name), provider.memoryKills(id.name)],
      { concurrency: 2 },
    );
    const idle = Duration.seconds(info.idleSeconds);
    const push = deadlinePush(provider, id.name, info);
    // A cold Keeper link bring-up can outlast a short host Deadline.
    yield* push;
    const keeper = yield* KeeperClient;
    const events = yield* keeper.exec(
      rawId,
      withSecrets(posix.join(provider.secretsDir(id.name), "env"), argv),
    );
    let exitCode: number | undefined;
    // The repeated push never completes on its own, so the stream's value wins.
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
      Effect.raceFirst(
        Effect.repeat(
          push,
          Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
        ),
      ),
    );
    const [killsAfter] = yield* Effect.all(
      [provider.memoryKills(id.name), push],
      { concurrency: 2 },
    );
    // On Linux the kill count is container-wide, so a new kill plus a clean
    // exit means the command hid an OOM child (e.g. an early pipeline
    // stage). On a Mac it is host-wide and takes in other apps, so only a
    // command that was itself killed (137) counts.
    const killed = exitCode === 137 || (exitCode === 0 && info.os !== "macos");
    if (killsAfter > killsBefore && killed) {
      const offered = provider.offers[info.os]?.sizes ?? "any";
      yield* output.err(`${outOfMemoryMessage(info.size, offered)}\n`);
      yield* output.setExitCode(OUT_OF_MEMORY_EXIT);
    }
  }).pipe(Effect.scoped);
