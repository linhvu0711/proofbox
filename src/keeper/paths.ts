import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Effect } from "effect";
import { ProviderError } from "../errors.ts";

export interface KeeperPaths {
  readonly dir: string;
  readonly socket: string;
  readonly pid: string;
}

export const keeperPaths = (id: {
  readonly provider: string;
  readonly name: string;
}): Effect.Effect<KeeperPaths, ProviderError> =>
  Effect.gen(function* () {
    const dir = yield* Config.string("PROOFBOX_RUNTIME_DIR").pipe(
      Config.withDefault(join(tmpdir(), `proofbox-${process.getuid?.() ?? 0}`)),
      Effect.mapError(
        (cause) =>
          new ProviderError({
            provider: id.provider,
            reason: String(cause),
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => mkdir(dir, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        new ProviderError({
          provider: id.provider,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const stem = `${id.provider}-${id.name}`;
    return {
      dir,
      socket: join(dir, `${stem}.sock`),
      pid: join(dir, `${stem}.pid`),
    };
  });
