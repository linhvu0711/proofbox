import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Clock, Duration, Effect, Option, Schedule } from "effect";
import { deadlineSeconds, parseDeadline } from "../deadline.ts";
import { SandboxGoneError } from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { fileStem } from "../sandbox-id.ts";
import { hostJob } from "./host-job.ts";

// The host's own Deadline drifts ahead of the Sandbox's: the gateway counts
// every ssh session as use and pushes the host's Deadline minutes out, so
// the recorded Sandbox Deadline — not the host's — is what this destroys
// at. `extend` can only push a Deadline later, never earlier, so there is
// no way to shorten a lifetime — destroy is the only floor, and the
// recorded deadline file is re-read right before destroying in case a push
// landed while this process was waking.
const SLACK_SECONDS = 15;

hostJob(({ region, instanceId, value: at, api }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* keeperPaths({
      provider: "ns",
      name: fileStem({ name: instanceId, region }),
    });
    const capFile = paths.maxLife;
    const epoch = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) =>
          Option.match(parseDeadline(text), {
            onNone: () => Number.NaN,
            onSome: (deadline) => deadlineSeconds(deadline),
          }),
        ),
        Effect.orElseSucceed(() => Number.NaN),
      );
    const exists = fs.exists(capFile).pipe(Effect.orElseSucceed(() => false));
    // Sleep until the earlier of the recorded Sandbox Deadline (with a
    // short slack for the container's own watchdog) and the Max life,
    // waking each minute to exit early when the Sandbox was deleted: its
    // cap file is gone, so the timer is no longer needed.
    yield* Effect.iterate(true, {
      while: (waiting) => waiting,
      body: () =>
        Effect.gen(function* () {
          if (!(yield* exists)) return false;
          const deadline = yield* epoch(paths.deadline);
          const destroyAt = Math.min(
            Number.isFinite(deadline)
              ? deadline + SLACK_SECONDS
              : Number.POSITIVE_INFINITY,
            at,
          );
          const left = Math.floor(
            destroyAt - (yield* Clock.currentTimeMillis) / 1000,
          );
          if (left > 0) {
            yield* Effect.sleep(Duration.seconds(Math.min(left, 60)));
            return true;
          }
          // A failed destroy at the Deadline must not leave the host
          // running: keep retrying until the host is gone (or the
          // request is hopeless for long enough that the host's own
          // Deadline is the backstop).
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
          return false;
        }),
    });
  }),
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
