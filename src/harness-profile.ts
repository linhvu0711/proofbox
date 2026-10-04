import { join } from "node:path";
import { Config, Effect } from "effect";

export const harnessProfilePath = (name: string) =>
  Effect.map(Config.string("HOME"), (home) =>
    join(home, ".config", "proofbox", "harness", name),
  );
