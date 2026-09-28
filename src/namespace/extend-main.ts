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
      const nsc = makeNscClient(executor);
      // The host is labeled with the Sandbox's Max life at create time. A
      // push beyond it would resurrect a host whose Sandbox is already
      // dead, so cap the bump there and treat "past Max life" as done.
      const cap = yield* nsc
        .list({ "proofbox.os": "linux" })
        .pipe(Effect.orElseSucceed(() => [] as const))
        .pipe(
          Effect.map((instances) => {
            const found = instances.find(
              (instance) => instance.clusterId === id,
            );
            const at = Number(found?.labels?.["proofbox.max-life-at"]);
            return Number.isFinite(at) && at > 0
              ? at
              : Number.POSITIVE_INFINITY;
          }),
        );
      const left = Math.floor(cap - Date.now() / 1000);
      if (left <= 0) return;
      const bump = Math.min(seconds, left);
      // The push is fire-and-forget from the caller's side: retry here until
      // the host accepts the Deadline or its own Deadline passes. A host that
      // is already gone needs no more tries.
      yield* nsc.extend(id, bump).pipe(
        Effect.retry(
          Schedule.spaced(Duration.seconds(15)).pipe(
            Schedule.upTo(Duration.seconds(bump)),
            Schedule.whileInput(
              (error) => !(error instanceof SandboxGoneError),
            ),
          ),
        ),
        Effect.ignore,
      );
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
