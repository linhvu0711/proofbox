import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { Effect, Option, Schedule } from "effect";
import type { ProviderError } from "../errors.ts";
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

const RETRY_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

// No Keeper answers: none is there, or one left before it read the
// request, as a Keeper does when its Sandbox is gone.
const KEEPER_AWAY = new Set([...RETRY_CODES, "EPIPE", "ECONNRESET"]);

export const keeperAway = (error: ProviderError) =>
  KEEPER_AWAY.has(error.reason);

const pathsOf = (id: ResolvedSandboxId) =>
  keeperPaths({ provider: id.prefix, name: fileStem(id) });

const removeKeeperFiles = (paths: KeeperPaths) =>
  Effect.promise(() =>
    Promise.all([
      rm(paths.socket, { force: true }).catch(() => {}),
      rm(paths.pid, { force: true }).catch(() => {}),
    ]).then(() => {}),
  );

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
  const paths = yield* pathsOf(id);
  const pidText = yield* Effect.promise(() =>
    readFile(paths.pid, "utf8").catch(() => ""),
  );
  const pid = Number.parseInt(pidText.trim(), 10);
  if (Number.isFinite(pid)) {
    // A stale pid file can name a reused, unrelated pid; only signal a
    // process that still runs keeper-main.
    const isKeeper = yield* Effect.promise(() =>
      promisify(execFile)("ps", ["-p", String(pid), "-o", "command="])
        .then(({ stdout }) => stdout.includes("keeper-main"))
        .catch(() => false),
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
