import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

// The real CommandExecutor, for a Provider a test builds outside an
// effect: a Namespace create runs ssh-keygen on this machine.
export const nodeExecutor = Effect.runSync(
  CommandExecutor.CommandExecutor.pipe(Effect.provide(NodeContext.layer)),
);
