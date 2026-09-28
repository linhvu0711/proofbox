import { spawn } from "node:child_process";
import { Effect } from "effect";
import { entryPath } from "./entry.ts";
import { ProviderError } from "./errors.ts";

export const spawnDetached = (
  provider: string,
  rel: string,
  args: ReadonlyArray<string>,
) =>
  Effect.try({
    try: () => {
      spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", entryPath(rel), ...args],
        { detached: true, stdio: "ignore" },
      ).unref();
    },
    catch: (cause) =>
      new ProviderError({
        provider,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
