// biome-ignore lint/style/noRestrictedImports: Keeper must outlive this process, and Command has no detached spawn.
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { entryPath } from "./entry.ts";
import { causeText, ProviderError } from "./errors.ts";

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
          reason: causeText(cause),
        }),
    }),
);
