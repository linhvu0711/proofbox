import { Effect, Stream } from "effect";
import type { LinuxHost } from "../../src/namespace/linux-host.ts";
import type { Os } from "../../src/provider.ts";

// A host a test must never reach: each step dies with words that name its
// OS, so a test that strays onto the other OS fails at once.
export const unusedHost = (os: Os): LinuxHost => {
  const why = `the ${os} host is not part of this test`;
  return {
    os,
    via: "gateway",
    reach: () => Effect.die(why),
    read: () => Effect.die(why),
    writeDeadline: () => Effect.die(why),
    checks: { push: "", kills: "", run: "" },
    call: () => () => Stream.die(why),
    livePassword: () => Effect.die(why),
    offer: { sizes: [], features: new Set() },
    defaultSize: { cpu: 1, ramGb: 1 },
    machine: { arch: "amd64", selectors: [] },
    make: () => Effect.die(why),
    folders: { state: "", secrets: "" },
    baseVersion: Effect.die(why),
    saveSnapshot: () => Effect.die(why),
  };
};
