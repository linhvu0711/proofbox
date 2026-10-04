import { randomBytes } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { Command, FileSystem } from "@effect/platform";
import { Effect, Option, Schedule } from "effect";
import { captureCommand } from "../command-events.ts";
import { ProviderError, platformReason } from "../errors.ts";
import {
  fileStem,
  formatSandboxId,
  type ResolvedSandboxId,
} from "../sandbox-id.ts";
import { spawnDetached } from "../spawn-detached.ts";
import { type KeeperPaths, keeperPaths } from "./paths.ts";
import {
  connectKeeper,
  encodeRequest,
  type RequestFrame,
  writeFrame,
} from "./protocol.ts";
import { withStartLock } from "./start-lock.ts";

const RETRY_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

// No Keeper answers: none is there, or one left before it read the
// request, as a Keeper does when its Sandbox is gone.
const KEEPER_AWAY = new Set([...RETRY_CODES, "EPIPE", "ECONNRESET"]);

export const keeperAway = (error: ProviderError) =>
  KEEPER_AWAY.has(error.reason);

const pathsOf = Effect.fn("lifecycle.pathsOf")((id: ResolvedSandboxId) =>
  keeperPaths({ provider: id.prefix, name: fileStem(id) }),
);

const removeKeeperFiles = Effect.fn("lifecycle.removeKeeperFiles")(function* (
  paths: KeeperPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.all(
    [
      Effect.ignore(fs.remove(paths.socket, { force: true })),
      Effect.ignore(fs.remove(paths.pid, { force: true })),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

// Starts the Keeper of Sandbox `id` and waits until its socket answers.
export const startKeeper = Effect.fn("lifecycle.startKeeper")(function* (
  id: ResolvedSandboxId,
) {
  const paths = yield* pathsOf(id);
  yield* spawnDetached(id.provider.name, "keeper/keeper-main", [
    formatSandboxId({
      provider: id.prefix,
      region: id.region,
      name: id.name,
    }),
  ]);
  yield* connectKeeper(paths.socket, id.provider.name).pipe(
    Effect.retry({
      while: (error) => RETRY_CODES.has(error.reason),
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo("10 seconds")),
    }),
    Effect.tap((socket) => Effect.sync(() => socket.destroy())),
  );
});

// A socket to the Keeper of Sandbox `id` that has taken `request`,
// starting a new Keeper when none answers. None when no Keeper takes it.
export const reachKeeper = Effect.fn("lifecycle.reachKeeper")(function* (
  id: ResolvedSandboxId,
  request: RequestFrame,
) {
  const paths = yield* pathsOf(id);
  // The Keeper never read a request it dropped, so after a new Keeper
  // starts the request goes again.
  const connect = connectKeeper(paths.socket, id.provider.name).pipe(
    Effect.tap((socket) =>
      writeFrame(socket, id.provider.name, encodeRequest(request)),
    ),
  );
  // With no Keeper, the Provider says first whether the Sandbox is
  // still there: a gone one fails here, with no Keeper started for it.
  return yield* connect.pipe(
    Effect.map((socket) => Option.some(socket)),
    Effect.catchAll((error) =>
      keeperAway(error)
        ? Effect.zipRight(
            id.provider.get(id),
            Effect.option(Effect.zipRight(startKeeper(id), connect)),
          )
        : Effect.succeed(Option.none<Socket>()),
    ),
  );
});

// Ends the Keeper of Sandbox `id`, if one runs, and removes its files.
export const stopKeeper = Effect.fn("lifecycle.stopKeeper")(function* (
  id: ResolvedSandboxId,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* pathsOf(id);
  const pidText = yield* fs
    .readFileString(paths.pid)
    .pipe(Effect.orElseSucceed(() => ""));
  const pid = Number.parseInt(pidText.trim(), 10);
  if (Number.isFinite(pid)) {
    // A stale pid file can name a reused, unrelated pid; only signal a
    // process that still runs keeper-main.
    const isKeeper = yield* captureCommand(
      Command.make("ps", "-p", String(pid), "-o", "command="),
    ).pipe(
      Effect.map(
        ({ exitCode, stdout }) =>
          exitCode === 0 && stdout.includes("keeper-main"),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (isKeeper) {
      yield* Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // ESRCH and friends: Keeper already gone
        }
      });
    }
  }
  yield* removeKeeperFiles(paths);
});

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
  const paths = yield* pathsOf(id);
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
