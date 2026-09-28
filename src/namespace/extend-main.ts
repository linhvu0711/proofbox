import { CommandExecutor } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { makeNscClient } from "./nsc-client.ts";

const id = process.argv[2];
const seconds = Number(process.argv[3]);

(id === undefined || !Number.isFinite(seconds)
  ? Effect.void
  : Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      yield* makeNscClient(executor).extend(id, seconds);
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
