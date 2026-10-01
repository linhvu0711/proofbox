import { readFile } from "node:fs/promises";
import { Clock, Duration, Effect, Schedule } from "effect";
import { SandboxGoneError } from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import type { SandboxRef } from "../provider.ts";
import { fileStem } from "../sandbox-id.ts";
import type { NamespaceApi } from "./namespace-api.ts";

// Pushes the host's own lifetime to `seconds` from now, never past the
// Sandbox's Max life. The caller does not wait on it: it retries until the
// host takes the push or `seconds` pass. Each try reads the Max-life cap
// again and works out the time left, so a late retry never pushes the host
// past Max life. A missing or unreadable cap means the create did not
// finish (or the Sandbox is being deleted): it skips the push rather than
// run with no cap.
export const pushHostLife = (
  api: NamespaceApi,
  ref: SandboxRef,
  seconds: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const capFile = (yield* keeperPaths({
      provider: "ns",
      name: fileStem(ref),
    })).maxLife;
    yield* Effect.gen(function* () {
      const cap = yield* Effect.tryPromise(() =>
        readFile(capFile, "utf8").then((text) => Number(text.trim())),
      ).pipe(Effect.orElseSucceed(() => Number.NaN));
      if (!Number.isFinite(cap)) return;
      const left = Math.floor(cap - (yield* Clock.currentTimeMillis) / 1000);
      if (left <= 0) return;
      yield* api.extend(ref.region ?? "", ref.name, Math.min(seconds, left));
    }).pipe(
      Effect.retry(
        Schedule.spaced(Duration.seconds(15)).pipe(
          Schedule.upTo(Duration.seconds(seconds)),
          Schedule.whileInput((error) => !(error instanceof SandboxGoneError)),
        ),
      ),
    );
  }).pipe(Effect.ignore);
