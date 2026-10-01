import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Duration, Effect, Schedule } from "effect";
import { ProviderError } from "../errors.ts";
import type { SandboxRef } from "../provider.ts";

export interface KeeperPaths {
  readonly dir: string;
  readonly socket: string;
  readonly pid: string;
  readonly key: string;
  // The host keys the Namespace SSH gateway pinned for the host.
  readonly knownHosts: string;
  readonly control: string;
  readonly maxLife: string;
  // The Sandbox's own Deadline as the detached host-expiry reads it: the
  // host dies at this instant even when use of it kept its own Deadline
  // further out.
  readonly deadline: string;
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
      knownHosts: join(dir, `${stem}.known-hosts`),
      control: join(dir, `${stem}.ctl`),
      maxLife: join(dir, `${stem}.max-life`),
      deadline: join(dir, `${stem}.deadline`),
      os: join(dir, `${stem}.os`),
    };
  });

// The Sandboxes this machine started for one Provider: each has a Max life
// file in the runtime dir, which the detached host-expiry watches, so these
// are the Sandboxes that need this machine's login to stop. The file stem
// is `fileStem`'s `<region>:<name>`, or `<name>` without a region.
export const localSandboxes = (
  prefix: string,
): Effect.Effect<ReadonlyArray<SandboxRef>, ProviderError> =>
  Effect.gen(function* () {
    const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" }))
      .dir;
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: (cause) =>
        new ProviderError({
          provider: prefix,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return entries.flatMap((entry) => {
      const stem = /^(.+)\.max-life$/.exec(entry)?.[1];
      if (stem === undefined || !stem.startsWith(`${prefix}-`)) {
        return [];
      }
      const rest = stem.slice(prefix.length + 1);
      const colon = rest.lastIndexOf(":");
      return [
        colon === -1
          ? { name: rest, region: undefined }
          : { name: rest.slice(colon + 1), region: rest.slice(0, colon) },
      ];
    });
  });

// A create still running leaves a create mark,
// `<prefix>-creating-<pid>-<random>`, in the runtime dir from its login
// check until its Max life file is written: its host can exist before that
// file does, so logout waits for it (ADR 0016). The random part keeps two
// creates in one process apart.
export const markCreate = (
  prefix: string,
): Effect.Effect<string, ProviderError> =>
  Effect.gen(function* () {
    const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" }))
      .dir;
    const path = join(
      dir,
      `${prefix}-creating-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    yield* Effect.tryPromise({
      try: () => writeFile(path, `${process.pid}\n`, { mode: 0o600 }),
      catch: (cause) =>
        new ProviderError({
          provider: prefix,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return path;
  });

export const unmarkCreate = (path: string) =>
  Effect.promise(() => rm(path, { force: true }).catch(() => {}));

// A live create touches its mark this often; a mark left untouched for
// STALE_MARK is stale, so a crashed create's process id, reused by some
// other process, cannot hold logout forever.
const MARK_BEAT = Duration.seconds(10);
const STALE_MARK = Duration.minutes(1);

// Runs until interrupted; a failed touch waits for the next beat.
export const keepMarkFresh = (path: string) =>
  Effect.promise(() => {
    const now = new Date();
    return utimes(path, now, now).catch(() => {});
  }).pipe(Effect.repeat(Schedule.spaced(MARK_BEAT)), Effect.asVoid);

// A process that is gone answers ESRCH; EPERM means it runs as someone
// else, which is still alive.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "EPERM"
    );
  }
};

// The marks of the creates still running for one Provider. A mark whose
// process is gone, or that nobody touched for STALE_MARK, is skipped.
export const liveCreates = (
  prefix: string,
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  Effect.gen(function* () {
    const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" }))
      .dir;
    const oldest = Date.now() - Duration.toMillis(STALE_MARK);
    return yield* Effect.tryPromise({
      try: async () => {
        const live: Array<string> = [];
        for (const entry of await readdir(dir)) {
          const pid = /^(\d+)-[0-9a-f]+$/.exec(
            entry.startsWith(`${prefix}-creating-`)
              ? entry.slice(`${prefix}-creating-`.length)
              : "",
          )?.[1];
          if (pid === undefined || !isAlive(Number(pid))) {
            continue;
          }
          // A mark removed since readdir is a create that just finished.
          const touched = await stat(join(dir, entry)).then(
            (info) => info.mtimeMs,
            () => 0,
          );
          if (touched >= oldest) {
            live.push(entry);
          }
        }
        return live;
      },
      catch: (cause) =>
        new ProviderError({
          provider: prefix,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });
