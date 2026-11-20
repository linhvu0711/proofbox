import { Effect } from "effect";
import type { Provider, ProviderEntry } from "../../src/provider.ts";

// The entry for a Provider that is already built.
export const providerEntry = (provider: Provider): ProviderEntry => ({
  name: provider.name,
  idPrefix: provider.idPrefix,
  load: Effect.succeed(provider),
});
