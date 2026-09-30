import { access } from "node:fs/promises";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Schedule } from "effect";
import { SandboxGoneError } from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { loginFor } from "../login/provider-login.ts";
import { makeNamespaceApi } from "./namespace-api.ts";
import { splitHostName } from "./regions.ts";

const id = process.argv[2];
const at = Number(process.argv[3]);

// The host's own Deadline starts when the Compute API finishes creating it,
// so it can sit later than the Sandbox's Max life; this detached process
// destroys the host at that absolute instant. `extend` can only push a
// Deadline later, never earlier, so there is no way to shorten the initial
// lifetime — destroy is the only floor.
(id === undefined || !Number.isFinite(at) || at <= 0
  ? Effect.void
  : Effect.gen(function* () {
      const api = makeNamespaceApi({ login: loginFor("namespace") });
      const capFile = (yield* keeperPaths({ provider: "ns", name: id }))
        .maxLife;
      const { region, instanceId } = splitHostName(id);
      // Sleep until the Max life, waking each minute to exit early when the
      // Sandbox was deleted: its cap file is gone, so the timer is no longer
      // needed.
      const exists = Effect.promise(() =>
        access(capFile).then(
          () => true,
          () => false,
        ),
      );
      yield* Effect.iterate(Math.floor(at - Date.now() / 1000), {
        while: (left) => left > 0,
        body: (left) =>
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(Math.min(left, 60)));
            if (!(yield* exists)) return 0;
            return Math.floor(at - Date.now() / 1000);
          }),
      });
      if (!(yield* exists)) return;
      // A failed destroy at the Max life must not leave the host running:
      // keep retrying until the host is gone (or the request is hopeless
      // for long enough that the host's own Deadline is the backstop).
      yield* api.destroy(region, instanceId).pipe(
        Effect.retry(
          Schedule.spaced(Duration.seconds(15)).pipe(
            Schedule.upTo(Duration.minutes(30)),
            Schedule.whileInput(
              (error) => !(error instanceof SandboxGoneError),
            ),
          ),
        ),
        Effect.ignore,
      );
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
