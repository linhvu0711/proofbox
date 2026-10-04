// Command from @effect/platform cannot spawn a detached process, and the
// Keeper must outlive this process, so this one spawn uses node:child_process.
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { entryPath } from "./entry.ts";
import { ProviderError } from "./errors.ts";

export const spawnDetached = Effect.fn("spawnDetached.spawnDetached")(
  (provider: string, rel: string, args: ReadonlyArray<string>) =>
    Effect.try({
      try: () => {
        spawn(process.execPath, [entryPath(rel), ...args], {
          detached: true,
          stdio: "ignore",
        }).unref();
      },
      catch: (cause) =>
        new ProviderError({
          provider,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }),
);
