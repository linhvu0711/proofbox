import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { ProviderError } from "./errors.ts";
import { keeperPaths, ownStart, stillRuns } from "./keeper/paths.ts";
import { withLoginsLock } from "./login/logins-file.ts";
import { envToken } from "./login/provider-login.ts";
import type { Provider } from "./provider.ts";

// The Sandboxes this machine started for one Provider: each has a Max life
// file in the runtime dir, which the detached host-expiry watches, so these
// are the Sandboxes that need this machine's login to stop. The file stem
// is `fileStem`'s `<region>:<name>`, or `<name>` without a region.
export const localSandboxes = Effect.fn("localSandboxes.localSandboxes")(
  function* (prefix: string) {
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
  },
);

// A create still running leaves a create mark,
// `<prefix>-creating-<pid>-<random>`, in the runtime dir from its login
// check until its Max life file is written: its host can exist before that
// file does, so logout waits for it (ADR 0016). The random part keeps two
// creates in one process apart. The mark holds the process id and the
// process's start time, so a crashed create's id, reused by some other
// process, does not pass for it.
const markCreate = Effect.fn("localSandboxes.markCreate")(function* (
  prefix: string,
) {
  const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" })).dir;
  const path = join(
    dir,
    `${prefix}-creating-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const started = yield* ownStart;
  yield* Effect.tryPromise({
    try: () => writeFile(path, `${process.pid}\n${started}\n`, { mode: 0o600 }),
    catch: (cause) =>
      new ProviderError({
        provider: prefix,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  return path;
});

const unmarkCreate = (path: string) =>
  Effect.promise(() => rm(path, { force: true }).catch(() => {}));

// The marks of the creates still running for one Provider. A mark whose
// process is gone, or whose process id now belongs to a process that
// started at another time, is skipped.
export const liveCreates = Effect.fn("localSandboxes.liveCreates")(function* (
  prefix: string,
) {
  const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" })).dir;
  const marks = yield* Effect.tryPromise({
    try: async () => {
      const found: Array<{ readonly name: string; readonly text: string }> = [];
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
    if (!/^\d+$/.test(pid)) {
      continue;
    }
    // With no start time to compare, a process id this user runs counts:
    // logout would rather wait than miss a host.
    if (yield* stillRuns(Number(pid), started)) {
      live.push(mark.name);
    }
  }
  return live;
});

// A create that may act with the saved login marks itself while the
// Provider makes the host, and writes the mark under the logins lock: a
// logout either waits for this create or has removed the login already,
// and then the Provider finds none (ADR 0016). The env token wins over the
// saved login, and logout never removes it, so a create with one needs no
// mark; nor does a Provider with no login, or a run with no HOME. The mark
// goes once `create` ends.
export const withCreateMark = Effect.fn("localSandboxes.withCreateMark")(
  function* <A, E, R>(provider: Provider, create: Effect.Effect<A, E, R>) {
    const mark = Effect.gen(function* () {
      if (provider.login._tag === "None") {
        return Option.none<string>();
      }
      // A redacted string can never fail to load, so `option` yields None
      // for a missing variable and anything else is a defect.
      if (Option.isSome(yield* Effect.orDie(envToken(provider.name)))) {
        return Option.none<string>();
      }
      return yield* withLoginsLock(markCreate(provider.idPrefix)).pipe(
        Effect.map((path) => Option.some(path)),
        Effect.catchTag("ConfigError", () =>
          Effect.succeed(Option.none<string>()),
        ),
      );
    });
    return yield* Effect.acquireUseRelease(
      mark,
      () => create,
      (marked) =>
        Option.match(marked, {
          onNone: () => Effect.void,
          onSome: unmarkCreate,
        }),
    );
  },
);
