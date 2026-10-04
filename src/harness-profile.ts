import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Config, Effect } from "effect";
import { HarnessError, platformReason } from "./errors.ts";

export const harnessProfilePath = Effect.fn(
  "harnessProfile.harnessProfilePath",
)((name: string) =>
  Effect.map(Config.string("HOME"), (home) =>
    join(home, ".config", "proofbox", "harness", name),
  ),
);

export const copyResolved = Effect.fn("harnessProfile.copyResolved")(function* (
  harness: string,
  from: string,
  to: string,
): Effect.fn.Return<void, HarnessError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const failed = (error: Parameters<typeof platformReason>[0]) =>
    new HarnessError({ harness, reason: platformReason(error) });
  const info = yield* fs.stat(from).pipe(Effect.mapError(failed));
  if (info.type === "Directory") {
    yield* fs.makeDirectory(to).pipe(Effect.mapError(failed));
    const names = yield* fs.readDirectory(from).pipe(Effect.mapError(failed));
    for (const name of names) {
      yield* copyResolved(harness, join(from, name), join(to, name));
    }
  } else {
    yield* fs.copyFile(from, to).pipe(Effect.mapError(failed));
  }
});
