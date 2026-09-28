import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Effect } from "effect";
import { ProviderError } from "../errors.ts";

export interface KeeperPaths {
  readonly dir: string;
  readonly socket: string;
  readonly pid: string;
  readonly key: string;
  readonly control: string;
  readonly maxLife: string;
  // The OS of a host made by a Provider with more than one OS.
  readonly os: string;
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
      try: async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // mkdir's mode only applies to a new dir; the socket must stay
        // unreachable by other local users even for a preexisting dir.
        await chmod(dir, 0o700);
      },
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
      key: join(dir, `${stem}.key`),
      control: join(dir, `${stem}.ctl`),
      maxLife: join(dir, `${stem}.max-life`),
      os: join(dir, `${stem}.os`),
    };
  });
