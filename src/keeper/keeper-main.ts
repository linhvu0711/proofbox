import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { ProvidersLive } from "../provider-registry.ts";
import { runKeeper } from "./keeper.ts";

const id = process.argv[2];

(id === undefined ? Effect.void : runKeeper(id)).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeContext.layer,
      ProvidersLive.pipe(Layer.provide(NodeContext.layer)),
    ),
  ),
  NodeRuntime.runMain,
);
