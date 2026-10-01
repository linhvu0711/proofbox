import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Effect } from "effect";
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
// creates in one process apart. The mark holds the process id and the
// process's start time, so a crashed create's id, reused by some other
// process, does not pass for it.
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
    const started = yield* startOf(process.pid);
    yield* Effect.tryPromise({
      try: () =>
        writeFile(path, `${process.pid}\n${started}\n`, { mode: 0o600 }),
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

// When a process started, as `ps` tells it, or "" when it is gone or `ps`
// cannot say. `ps` lives in /bin or /usr/bin on macOS and Linux, and the
// C locale keeps the text the same in every process.
const startOf = (pid: number) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        execFile(
          "ps",
          ["-o", "lstart=", "-p", String(pid)],
          { env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } },
          (error, stdout) => resolve(error === null ? stdout.trim() : ""),
        );
      }),
  );

// The marks of the creates still running for one Provider. A mark whose
// process is gone, or whose process id now belongs to a process that
// started at another time, is skipped.
export const liveCreates = (
  prefix: string,
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  Effect.gen(function* () {
    const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" }))
      .dir;
    const marks = yield* Effect.tryPromise({
      try: async () => {
        const found: Array<{ readonly name: string; readonly text: string }> =
          [];
        for (const entry of await readdir(dir)) {
          if (
            /^\d+-[0-9a-f]+$/.test(
              entry.startsWith(`${prefix}-creating-`)
                ? entry.slice(`${prefix}-creating-`.length)
                : "",
            )
          ) {
            // A mark removed since readdir is a create that just finished.
            const text = await readFile(join(dir, entry), "utf8").catch(
              () => undefined,
            );
            if (text !== undefined) {
              found.push({ name: entry, text });
            }
          }
        }
        return found;
      },
      catch: (cause) =>
        new ProviderError({
          provider: prefix,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const live: Array<string> = [];
    for (const mark of marks) {
      const [pid = "", started = ""] = mark.text.split("\n");
      const now = /^\d+$/.test(pid) ? yield* startOf(Number(pid)) : "";
      // A mark without a start time counts while its process id runs.
      if (now !== "" && (started === "" || started === now)) {
        live.push(mark.name);
      }
    }
    return live;
  });
