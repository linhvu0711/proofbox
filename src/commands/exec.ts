import { posix } from "node:path";
import { Effect, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { type MemoryKills, Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";
import { withSecrets } from "../secrets.ts";
import { OUT_OF_MEMORY_EXIT, outOfMemoryMessage } from "../size.ts";

export const execInSandbox = Effect.fn("exec.execInSandbox")(function* (
  rawId: string,
  argv: ReadonlyArray<string>,
) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const provider = id.provider;
  const output = yield* CliOutput;
  const keeper = yield* KeeperClient;
  // The Keeper pushes the Deadline and reads the memory-kill counts in the
  // command's own call (ADR 0015).
  const info = yield* keeper.info(rawId);
  const events = yield* keeper.exec(
    rawId,
    withSecrets(posix.join(provider.secretsDir(id.name, info.os), "env"), argv),
  );
  let exitCode: number | undefined;
  let kills: MemoryKills | undefined;
  yield* events.pipe(
    Stream.runForEach((event) => {
      switch (event._tag) {
        case "Stdout":
          return output.out(event.bytes);
        case "Stderr":
          return output.err(event.bytes);
        case "Exit":
          exitCode = event.code;
          kills = event.kills;
          return output.setExitCode(event.code);
      }
    }),
  );
  // On Linux the kill count is container-wide, so a new kill plus a clean
  // exit means the command hid an OOM child (e.g. an early pipeline
  // stage). On a Mac it is host-wide and takes in other apps, so only a
  // command that was itself killed (137) counts.
  const killed = exitCode === 137 || (exitCode === 0 && info.os !== "macos");
  if (kills !== undefined && kills.after > kills.before && killed) {
    const offered = provider.offers[info.os]?.sizes ?? "any";
    yield* output.err(`${outOfMemoryMessage(info.size, offered)}\n`);
    yield* output.setExitCode(OUT_OF_MEMORY_EXIT);
  }
}, Effect.scoped);
