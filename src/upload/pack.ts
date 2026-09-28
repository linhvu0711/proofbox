import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Ref, Stream } from "effect";
import {
  ProviderError,
  UploadFailedError,
  WorkFileGrewError,
} from "../errors.ts";

const local = (cause: unknown) =>
  new ProviderError({
    provider: "local",
    reason: cause instanceof Error ? cause.message : String(cause),
  });

// Room for tar's own bytes on top of the file data: a 512-byte header per
// entry, data padded to 512, a long-name or pax header for a long or
// non-ASCII path, and two zero blocks padded to a 10240-byte record. Loose on
// purpose; it only has to stop a file that grew after the size check.
const tarAllowance = (paths: ReadonlyArray<string>) =>
  paths.reduce(
    (total, path) => total + 2048 + 2 * Buffer.byteLength(path),
    20_480,
  );

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
      ).pipe(Effect.mapError(local));
      // The size check ran on the list; a file that grew since then reaches
      // tar at its new size, so the limit is held again on the bytes sent.
      const cap = limit + tarAllowance(paths);
      const sent = yield* Ref.make(0);
      const outputs = process.stdout.pipe(
        Stream.mapError(local),
        Stream.mapEffect((chunk) =>
          Ref.updateAndGet(sent, (total) => total + chunk.length).pipe(
            Effect.filterOrFail(
              (total) => total <= cap,
              () => new WorkFileGrewError({ limit }),
            ),
            Effect.as(chunk),
          ),
        ),
      );
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
