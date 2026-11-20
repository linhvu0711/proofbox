import { randomBytes } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { ProviderError, platformReason } from "../errors.ts";
import type { ResolvedSandboxId } from "../sandbox-id.ts";
import { type KeeperPaths, keeperPathsOf } from "./paths.ts";
import { withStartLock } from "./start-lock.ts";

export const removeKeeperFiles = Effect.fn("lifecycle.removeKeeperFiles")(
  function* (paths: KeeperPaths) {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.all(
      [
        Effect.ignore(fs.remove(paths.socket, { force: true })),
        Effect.ignore(fs.remove(paths.pid, { force: true })),
      ],
      { concurrency: "unbounded", discard: true },
    );
  },
);

// Whether a Keeper answers on `socket`.
export const keeperAnswers = Effect.fn("lifecycle.keeperAnswers")(
  (socket: string) =>
    Effect.async<boolean>((resume) => {
      const probe = createConnection({ path: socket }, () => {
        probe.destroy();
        resume(Effect.succeed(true));
      });
      probe.once("error", () => {
        probe.destroy();
        resume(Effect.succeed(false));
      });
    }),
);

// Makes this process the Keeper of Sandbox `id`: its pid file and its
// socket, served by `onClient`, until the scope ends. False when another
// Keeper already answers.
export const holdKeeper = Effect.fn("lifecycle.holdKeeper")(function* (
  id: ResolvedSandboxId,
  onClient: (socket: Socket) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* keeperPathsOf(id);
  // Under the lock, check the socket again: a Keeper that waited for
  // the lock finds the first one's socket answers, and ends.
  return yield* withStartLock(
    paths.startLock,
    id.provider.name,
    Effect.gen(function* () {
      if (yield* keeperAnswers(paths.socket)) {
        return false;
      }
      yield* Effect.ignore(fs.remove(paths.socket, { force: true }));
      // Write a unique temp file and rename it over the pid file, so a
      // reader never sees it empty.
      const temp = `${paths.pid}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      yield* Effect.acquireRelease(
        fs.writeFileString(temp, `${process.pid}\n`).pipe(
          Effect.zipRight(fs.rename(temp, paths.pid)),
          Effect.tapError(() =>
            Effect.ignore(fs.remove(temp, { force: true })),
          ),
          Effect.mapError(
            (error) =>
              new ProviderError({
                provider: id.provider.name,
                reason: platformReason(error),
              }),
          ),
        ),
        () => removeKeeperFiles(paths),
      );
      yield* Effect.acquireRelease(
        Effect.async<Server, ProviderError>((resume) => {
          const server = createServer(onClient);
          server.once("error", (error) =>
            resume(
              Effect.fail(
                new ProviderError({
                  provider: id.provider.name,
                  reason: error.message,
                }),
              ),
            ),
          );
          server.listen(paths.socket, () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.promise(
            () => new Promise<void>((done) => server.close(() => done())),
          ),
      );
      return true;
    }),
  );
});
