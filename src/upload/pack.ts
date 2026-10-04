import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import {
  ProviderError,
  UploadFailedError,
  WorkFileGrewError,
} from "../errors.ts";
import { tarFileBytes } from "./tar-file-bytes.ts";

const local = (cause: unknown) =>
  new ProviderError({
    provider: "local",
    reason: cause instanceof Error ? cause.message : String(cause),
  });

export const packFiles = (
  folder: string,
  id: string,
  paths: ReadonlyArray<string>,
  limit: number,
): Stream.Stream<
  Uint8Array,
  ProviderError | UploadFailedError | WorkFileGrewError
> =>
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
      ).pipe(Effect.mapError((error) => local(error)));
      // The size check ran on the list; a file that grew since then reaches
      // tar at its new size, so the limit is held again on the file bytes
      // the tar headers state as they go out.
      const fileBytes = tarFileBytes();
      const outputs = process.stdout.pipe(
        Stream.mapError((error) => local(error)),
        Stream.mapEffect((chunk) =>
          fileBytes(chunk) > limit
            ? Effect.fail(new WorkFileGrewError({ limit }))
            : Effect.succeed(chunk),
        ),
      );
      const drained = Stream.fromEffect(
        Stream.runDrain(process.stderr).pipe(
          Effect.mapError((error) => local(error)),
        ),
      ).pipe(Stream.drain);
      const checked = Stream.fromEffect(
        process.exitCode.pipe(
          Effect.mapError((error) => local(error)),
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
