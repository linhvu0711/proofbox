import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import {
  ConfigProvider,
  Duration,
  Effect,
  Either,
  Option,
  Schedule,
} from "effect";
import { ProviderError, platformReason } from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { keeperPaths, ownStart, stillRuns } from "./keeper/paths.ts";
import {
  type LoginsFile,
  readLogins,
  rewriteLogins,
  withLoginsLock,
} from "./login/logins-file.ts";
import { envToken, envTokenName } from "./login/provider-login.ts";
import type { Provider } from "./provider.ts";
import { formatSandboxId } from "./sandbox-id.ts";

// The Sandboxes this machine started for one Provider: each has a Max life
// file in the runtime dir, which the detached host-expiry watches, so these
// are the Sandboxes that need this machine's login to stop. The file stem
// is `fileStem`'s `<region>:<name>`, or `<name>` without a region.
const localSandboxes = Effect.fn("localSandboxes.localSandboxes")(function* (
  prefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" })).dir;
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.mapError(
      (error) =>
        new ProviderError({
          provider: prefix,
          reason: platformReason(error),
        }),
    ),
  );
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
const markCreate = Effect.fn("localSandboxes.markCreate")(function* (
  prefix: string,
) {
  const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" })).dir;
  const path = join(
    dir,
    `${prefix}-creating-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const started = yield* ownStart;
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(path, `${process.pid}\n${started}\n`, { mode: 0o600 })
    .pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({
            provider: prefix,
            reason: platformReason(error),
          }),
      ),
    );
  return path;
});

const unmarkCreate = Effect.fn("localSandboxes.unmarkCreate")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.ignore(fs.remove(path, { force: true }));
});

// The marks of the creates still running for one Provider. A mark whose
// process is gone, or whose process id now belongs to a process that
// started at another time, is skipped.
const liveCreates = Effect.fn("localSandboxes.liveCreates")(function* (
  prefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = (yield* keeperPaths({ provider: prefix, name: "__probe__" })).dir;
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.mapError(
      (error) =>
        new ProviderError({
          provider: prefix,
          reason: platformReason(error),
        }),
    ),
  );
  const marks: Array<{ readonly name: string; readonly text: string }> = [];
  for (const entry of entries) {
    if (
      /^\d+-[0-9a-f]+$/.test(
        entry.startsWith(`${prefix}-creating-`)
          ? entry.slice(`${prefix}-creating-`.length)
          : "",
      )
    ) {
      // A mark removed since readdir is a create that just finished.
      const text = yield* fs
        .readFileString(join(dir, entry))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (text !== undefined) {
        marks.push({ name: entry, text });
      }
    }
  }
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
          onSome: (path) => unmarkCreate(path),
        }),
    );
  },
);

// What logout could not do. Each one fails the command: a Sandbox this
// machine started may still run.
export type LogoutFailure =
  | { readonly _tag: "ScanFailed"; readonly reason: string }
  | {
      readonly _tag: "DeleteFailed";
      readonly id: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "LoginFilesKept";
      readonly what: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "Unchecked";
      readonly where: string;
      readonly reason: string;
    };

// What logout did: the ids it deleted, the Sandboxes and Unfinished
// Sandboxes it left because another machine started them, and its
// failures in the order they happened.
export type LogoutResult =
  | { readonly _tag: "NoLogin" }
  | {
      readonly _tag: "LoggedOut";
      readonly deleted: ReadonlyArray<string>;
      readonly elsewhere: ReadonlyArray<string>;
      readonly unfinishedElsewhere: ReadonlyArray<string>;
      readonly failures: ReadonlyArray<LogoutFailure>;
    };

// Logout deletes the Sandboxes this machine started, since their
// host-expiry needs the login it is about to remove (ADR 0016), then
// removes the saved slot. `onWaiting` hears how many creates still run
// before logout waits for them.
export const logOut = Effect.fn("localSandboxes.logOut")(function* (
  provider: Provider,
  onWaiting: (creates: number) => Effect.Effect<void>,
) {
  const logins = yield* readLogins;
  if (logins[provider.name] === undefined) {
    return { _tag: "NoLogin" } as const satisfies LogoutResult;
  }
  // Logout acts with the saved login it removes, never the env token: a
  // token for another account would not see this machine's Sandboxes,
  // and delete would take them for gone.
  const hidden = envTokenName(provider.name);
  const withSavedLogin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.configProviderWith((current) =>
      Effect.withConfigProvider(
        effect,
        ConfigProvider.mapInputPath(current, (path) =>
          path === hidden ? `${hidden}_HIDDEN_BY_LOGOUT` : path,
        ),
      ),
    );
  const listed = yield* Effect.either(withSavedLogin(provider.list));
  const keeper = yield* KeeperClient;
  const idOf = (ref: {
    readonly name: string;
    readonly region?: string | undefined;
  }) =>
    formatSandboxId({
      provider: provider.idPrefix,
      region: ref.region,
      name: ref.name,
    });
  const localIds = new Set<string>();
  const deleted: Array<string> = [];
  const failures: Array<LogoutFailure> = [];
  let scanFailed = false;
  // Waits for the creates still running, then deletes every Sandbox
  // this machine started that it has not tried yet.
  const sweep = Effect.gen(function* () {
    const running = yield* liveCreates(provider.idPrefix).pipe(
      Effect.orElseSucceed(() => []),
    );
    if (running.length > 0) {
      yield* onWaiting(running.length);
      yield* liveCreates(provider.idPrefix).pipe(
        Effect.orElseSucceed(() => []),
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(500)),
          until: (left) => left.length === 0,
        }),
      );
    }
    // A runtime dir it cannot read must not keep the login: the failure
    // is named and the login still goes.
    const scanned = yield* Effect.either(localSandboxes(provider.idPrefix));
    if (Either.isLeft(scanned)) {
      if (!scanFailed) {
        scanFailed = true;
        failures.push({ _tag: "ScanFailed", reason: scanned.left.reason });
      }
      return;
    }
    for (const ref of scanned.right) {
      const id = idOf(ref);
      if (localIds.has(id)) {
        continue;
      }
      localIds.add(id);
      // "gone" counts too: the host is already down, and delete dropped
      // its files.
      const result = yield* Effect.either(withSavedLogin(provider.delete(ref)));
      yield* keeper.stop(id);
      if (Either.isRight(result)) {
        deleted.push(id);
      } else {
        failures.push({
          _tag: "DeleteFailed",
          id,
          reason: result.left.message,
        });
      }
    }
  });
  // The last look for running creates and the login's removal share the
  // logins lock with each create's mark: a create that marked itself in
  // the meantime sends logout back to wait for it.
  let before: Option.Option<LoginsFile> = Option.none();
  while (Option.isNone(before)) {
    yield* sweep;
    before = yield* withLoginsLock(
      Effect.gen(function* () {
        const running = yield* liveCreates(provider.idPrefix).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (running.length > 0) {
          return Option.none();
        }
        return Option.some(
          yield* rewriteLogins((saved) => {
            const rest = { ...saved };
            delete rest[provider.name];
            return rest;
          }),
        );
      }),
    );
  }
  if (before.value[provider.name] === undefined) {
    return { _tag: "NoLogin" } as const satisfies LogoutResult;
  }
  // A failure here is named like the others; the login is gone already.
  for (const files of provider.loginFiles) {
    const cleared = yield* Effect.either(
      Effect.gen(function* () {
        const dir = (yield* keeperPaths({
          provider: provider.idPrefix,
          name: "__probe__",
        })).dir;
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.gen(function* () {
          for (const file of yield* fs.readDirectory(dir)) {
            if (files.names.test(file)) {
              yield* fs.remove(join(dir, file), { force: true });
            }
          }
        }).pipe(
          Effect.mapError(
            (error) =>
              new ProviderError({
                provider: provider.name,
                reason: platformReason(error),
              }),
          ),
        );
      }),
    );
    if (Either.isLeft(cleared)) {
      failures.push({
        _tag: "LoginFilesKept",
        what: files.what,
        reason: cleared.left.reason,
      });
    }
  }
  // A Sandbox from another machine stops by that machine's login; it
  // stays. An Unfinished Sandbox from elsewhere stays too, but it uses
  // quota. Without a scan there is no telling local from elsewhere: name
  // neither.
  const known = Either.isRight(listed) && !scanFailed;
  const elsewhere = known
    ? listed.right.infos.map(idOf).filter((id) => !localIds.has(id))
    : [];
  const unfinishedElsewhere = known
    ? listed.right.unfinished.map(idOf).filter((id) => !localIds.has(id))
    : [];
  const unchecked = Either.isRight(listed)
    ? listed.right.unreached
    : [{ where: provider.name, reason: listed.left.message }];
  for (const miss of unchecked) {
    failures.push({
      _tag: "Unchecked",
      where: miss.where,
      reason: miss.reason,
    });
  }
  return {
    _tag: "LoggedOut",
    deleted,
    elsewhere,
    unfinishedElsewhere,
    failures,
  } as const satisfies LogoutResult;
});
