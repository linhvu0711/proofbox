import { CommandExecutor } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect } from "effect";
import { makeNscClient } from "./nsc-client.ts";

const id = process.argv[2];
const at = Number(process.argv[3]);

// The host's own Deadline starts when nsc finishes creating it, so it can
// sit later than the Sandbox's Max life; this detached process destroys the
// host at that absolute instant. `extend --ensure_minimum` can only push a
// Deadline later, never earlier, so there is no way to shorten the initial
// lifetime — destroy is the only floor.
(id === undefined || !Number.isFinite(at) || at <= 0
  ? Effect.void
  : Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const nsc = makeNscClient(executor);
      const left = Math.floor(at - Date.now() / 1000);
      if (left > 0) {
        yield* Effect.sleep(Duration.seconds(left));
      }
      yield* nsc.destroy(id).pipe(Effect.ignore);
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
