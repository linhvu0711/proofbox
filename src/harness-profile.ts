import { join, relative } from "node:path";
import { FileSystem } from "@effect/platform";
import { Config, Effect, Either, Option } from "effect";
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
  home: string,
  ancestors: ReadonlySet<string> = new Set(),
): Effect.fn.Return<
  ReadonlyArray<string>,
  HarnessError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const failed = (error: Parameters<typeof platformReason>[0]) =>
    new HarnessError({ harness, reason: platformReason(error) });
  const link = yield* fs.readLink(from).pipe(Effect.option);
  const real = yield* fs.realPath(from).pipe(Effect.either);
  if (Either.isLeft(real)) {
    const error = real.left;
    if (
      error._tag === "SystemError" &&
      ((Option.isSome(link) && error.reason === "NotFound") ||
        (typeof error.cause === "object" &&
          error.cause !== null &&
          "code" in error.cause &&
          error.cause.code === "ELOOP"))
    ) {
      return [relative(home, from)];
    }
    return yield* Effect.fail(failed(error));
  }
  const info = yield* fs.stat(from).pipe(Effect.mapError(failed));
  if (info.type === "Directory") {
    if (ancestors.has(real.right)) {
      return [relative(home, from)];
    }
    const inside = new Set([...ancestors, real.right]);
    yield* fs.makeDirectory(to, { mode: 0o700 }).pipe(Effect.mapError(failed));
    const names = yield* fs.readDirectory(from).pipe(Effect.mapError(failed));
    const skipped: string[] = [];
    for (const name of names) {
      skipped.push(
        ...(yield* copyResolved(
          harness,
          join(from, name),
          join(to, name),
          home,
          inside,
        )),
      );
    }
    yield* fs.chmod(to, info.mode & 0o777).pipe(Effect.mapError(failed));
    return skipped;
  }
  yield* fs.copyFile(from, to).pipe(Effect.mapError(failed));
  return [];
});
