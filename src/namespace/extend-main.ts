import { CommandExecutor } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Schedule } from "effect";
import { SandboxGoneError } from "../errors.ts";
import { makeNscClient } from "./nsc-client.ts";

const id = process.argv[2];
const seconds = Number(process.argv[3]);

(id === undefined || !Number.isFinite(seconds) || seconds <= 0
  ? Effect.void
  : Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      // The push is fire-and-forget from the caller's side: retry here until
      // the host accepts the Deadline or its own Deadline passes. A host that
      // is already gone needs no more tries.
      yield* makeNscClient(executor)
        .extend(id, seconds)
        .pipe(
          Effect.retry(
            Schedule.spaced(Duration.seconds(15)).pipe(
              Schedule.upTo(Duration.seconds(seconds)),
              Schedule.whileInput(
                (error) => !(error instanceof SandboxGoneError),
              ),
            ),
          ),
          Effect.ignore,
        );
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
