import { Duration, Effect, Schedule } from "effect";
import { CliOutput } from "../cli-output.ts";
import { deadlinePush } from "../deadline.ts";
import { lacksFeature, Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";

export const openLive = Effect.fn("live.openLive")(function* (rawId: string) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const provider = id.provider;
  const liveView = provider.liveView;
  const info = yield* provider.get(id);
  if (
    !provider.offers[info.os]?.features.has("live-view") ||
    liveView === undefined
  ) {
    return yield* lacksFeature(
      provider,
      info.os,
      "live-view",
      "no Live view was opened",
    );
  }
  const output = yield* CliOutput;
  const idle = Duration.seconds(info.idleSeconds);
  const push = deadlinePush(provider, id, info);
  // Live setup holds the link for a while; push the Deadline first.
  yield* push;
  const view = yield* liveView(id);
  yield* output.out(`${view.address}\npassword ${view.password}\n`);
  yield* output.err("proofbox: Live view open; press Ctrl-C to close\n");
  // The Live view stays open until Ctrl-C interrupts the loop or the
  // port-forward dies — a dead forward means the address is useless.
  yield* Effect.raceFirst(
    Effect.repeat(
      push,
      Schedule.spaced(Duration.millis(Duration.toMillis(idle) / 3)),
    ),
    view.gone,
  );
}, Effect.scoped);
