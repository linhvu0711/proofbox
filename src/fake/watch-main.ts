import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { watchSandbox } from "./watch.ts";

const [, , root, name] = process.argv;
const program =
  root !== undefined && name !== undefined
    ? watchSandbox(root, name)
    : Effect.void;

program.pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
