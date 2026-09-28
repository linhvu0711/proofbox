import { Duration, Effect, Schedule } from "effect";
import { CliOutput } from "../cli-output.ts";
import { deadlinePush } from "../deadline.ts";
import { MissingCapabilityError } from "../errors.ts";
import { Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";

export const openLive = (rawId: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const liveView = provider.liveView;
    if (!provider.capabilities.has("live-view") || liveView === undefined) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "live-view",
        outcome: "no Live view was opened",
      });
    }
    const output = yield* CliOutput;
    const info = yield* provider.get(id.name);
    const view = yield* liveView(id.name);
    yield* output.out(`${view.address}\npassword ${view.password}\n`);
    yield* output.err("proofbox: Live view open; press Ctrl-C to close\n");
    const idle = Duration.seconds(info.idleSeconds);
    const push = deadlinePush(provider, id.name, info);
    // The Live view stays open until Ctrl-C interrupts the loop.
    yield* Effect.repeat(
      push,
      Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
    );
  }).pipe(Effect.scoped);
