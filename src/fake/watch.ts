import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Duration, Effect } from "effect";
import { ProviderError } from "../errors.ts";
import { describe } from "./fake-provider.ts";

const fail = (reason: string) =>
  new ProviderError({ provider: "fake", reason });

const readDeadline = Effect.fn("watch.readDeadline")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(join(root, name, "deadline"))
    .pipe(Effect.mapError((error) => fail(describe(error))));
  if (!/^[0-9]+\n?$/.test(text)) {
    return yield* fail("could not read the Deadline");
  }
  return new Date(Number(text.trim()) * 1000);
});

// Both loops stay inside one call, so a long-lived Sandbox keeps one span
// open instead of one more each second.
const deleteSandbox = Effect.fn("watch.deleteSandbox")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  while (true) {
    const deleted = yield* fs
      .remove(join(root, name), { recursive: true, force: true })
      .pipe(
        Effect.mapError((error) => fail(describe(error))),
        Effect.option,
      );
    if (deleted._tag === "Some") {
      return;
    }
    // A partial rm can remove the Deadline file first, so retry the delete itself
    // instead of reading the Deadline again.
    yield* Effect.sleep("1 seconds");
  }
});

export const watchSandbox = Effect.fn("watch.watchSandbox")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // Any error reads as "not there", as `existsSync` does.
  while (
    yield* fs.exists(join(root, name)).pipe(Effect.orElseSucceed(() => false))
  ) {
    const deadline = yield* readDeadline(root, name).pipe(Effect.option);
    if (deadline._tag === "None") {
      // A Deadline file not yet written whole reads as no Deadline; retry
      // instead of stopping the watcher.
      yield* Effect.sleep("1 seconds");
      continue;
    }
    const remaining = deadline.value.getTime() - Date.now();
    if (remaining <= 0) {
      yield* deleteSandbox(root, name);
      return;
    }
    yield* Effect.sleep(
      Duration.millis(Math.min(remaining, Duration.toMillis("1 seconds"))),
    );
  }
});
