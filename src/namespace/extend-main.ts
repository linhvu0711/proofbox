import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { hostJob } from "./host-job.ts";
import { pushHostLife } from "./host-life.ts";

hostJob(({ region, instanceId, value: seconds, api }) =>
  pushHostLife(api, { name: instanceId, region }, seconds),
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
