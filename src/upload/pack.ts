import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { ProviderError, UploadFailedError } from "../errors.ts";

const local = (cause: unknown) =>
  new ProviderError({
    provider: "local",
    reason: cause instanceof Error ? cause.message : String(cause),
  });

export const packFiles = (
  folder: string,
  id: string,
  paths: ReadonlyArray<string>,
): Stream.Stream<Uint8Array, ProviderError | UploadFailedError> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const list = new TextEncoder().encode(paths.join("\0"));
      const process = yield* Command.start(
        Command.make(
          "tar",
          "-c",
          "-f",
          "-",
          "--no-recursion",
          "--no-xattrs",
          "--null",
          "-T",
          "-",
        ).pipe(
          Command.workingDirectory(folder),
          Command.env({ COPYFILE_DISABLE: "1" }),
          Command.stdin(Stream.make(list)),
        ),
      ).pipe(Effect.mapError(local));
      const outputs = process.stdout.pipe(Stream.mapError(local));
      const drained = Stream.fromEffect(
        Stream.runDrain(process.stderr).pipe(Effect.mapError(local)),
      ).pipe(Stream.drain);
      const checked = Stream.fromEffect(
        process.exitCode.pipe(
          Effect.mapError(local),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new UploadFailedError({ id, command: "tar -c", code }),
                ),
          ),
        ),
      ).pipe(Stream.drain);
      return Stream.concat(Stream.merge(outputs, drained), checked);
    }),
  ).pipe(Stream.provideSomeLayer(NodeContext.layer));
