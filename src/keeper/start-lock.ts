import { Duration, type Effect } from "effect";
import { ProviderError, platformReason } from "../errors.ts";
import { withFileLock } from "../file-lock.ts";

// Runs a Keeper's start, from its socket check until it listens, under a
// lock per Sandbox, so a second Keeper started at once waits and then
// finds the first one's socket answers.
export const withStartLock = <A, E, R>(
  dir: string,
  provider: string,
  effect: Effect.Effect<A, E, R>,
) =>
  withFileLock({
    dir,
    wait: Duration.seconds(5),
    busy: () =>
      new ProviderError({
        provider,
        reason: `another Keeper of this Sandbox is still starting; delete ${dir} if it is stale`,
      }),
    failed: (error) =>
      new ProviderError({ provider, reason: platformReason(error) }),
  })(effect);
