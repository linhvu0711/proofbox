import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Duration, Effect, Schema } from "effect";
import { ProviderError } from "../errors.ts";
import { describe, SandboxFile } from "./fake-provider.ts";

const fail = (reason: string) =>
  new ProviderError({ provider: "fake", reason });

const readDeadline = Effect.fn("watch.readDeadline")(function* (
  root: string,
  name: string,
) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(join(root, name, "sandbox.json"), "utf8"),
    catch: (cause) => fail(describe(cause)),
  });
  const json = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => fail(describe(cause)),
  });
  const file = yield* Schema.decodeUnknown(SandboxFile)(json).pipe(
    Effect.mapError((error) => fail(error.message)),
  );
  return file.deadline;
});

const deleteSandbox: (root: string, name: string) => Effect.Effect<void> =
  Effect.fn("watch.deleteSandbox")(function* (root: string, name: string) {
    const deleted = yield* Effect.tryPromise({
      try: () => rm(join(root, name), { recursive: true, force: true }),
      catch: (cause) => fail(describe(cause)),
    }).pipe(Effect.option);
    if (deleted._tag === "None") {
      // A partial rm can remove sandbox.json first, so retry the delete itself
      // instead of reading the Deadline again.
      yield* Effect.sleep("1 seconds");
      return yield* deleteSandbox(root, name);
    }
  });

export const watchSandbox: (root: string, name: string) => Effect.Effect<void> =
  Effect.fn("watch.watchSandbox")(function* (root: string, name: string) {
    if (!existsSync(join(root, name))) {
      return;
    }
    const deadline = yield* readDeadline(root, name).pipe(Effect.option);
    if (deadline._tag === "None") {
      // A concurrent extend can leave a partially written sandbox.json; retry
      // instead of stopping the watcher.
      if (existsSync(join(root, name))) {
        yield* Effect.sleep("1 seconds");
        return yield* watchSandbox(root, name);
      }
      return;
    }
    const remaining = deadline.value.getTime() - Date.now();
    if (remaining <= 0) {
      yield* deleteSandbox(root, name);
      return;
    }
    yield* Effect.sleep(
      Duration.millis(Math.min(remaining, Duration.toMillis("1 seconds"))),
    );
    return yield* watchSandbox(root, name);
  });
