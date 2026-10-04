import { randomUUID } from "node:crypto";
// The one sync check: `commandEvents` maps a spawn failure with a plain
// function, and FileSystem has no sync `exists`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, CommandExecutor, type FileSystem } from "@effect/platform";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import type { ChecksShell } from "../command-checks.ts";
import { commandEvents } from "../command-events.ts";
import { nextDeadline } from "../deadline.ts";
import {
  ProviderError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenRejectedError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import {
  type Connection,
  IdleSeconds,
  Os,
  type Provider,
  type ProviderAccount,
  type ProviderLogin,
  SandboxInfo,
  type SandboxRef,
  type UnfinishedSandbox,
} from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import { shellJoin } from "../shell.ts";
import { Size } from "../size.ts";
import { spawnDetached } from "../spawn-detached.ts";

export class SandboxFile extends Schema.Class<SandboxFile>("SandboxFile")({
  os: Os,
  createdAt: Schema.Date,
  idleSeconds: IdleSeconds,
  maxLifeAt: Schema.Date,
  size: Schema.optional(Size),
  snapshot: Schema.optional(Schema.String),
}) {}

export const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// The checks around a command on the Caller's machine (ADR 0015): the
// Deadline file `get` reads, with no temp file left when the write fails;
// the memory-kill count a command may raise in `memory-kills`; and the
// command in the Sandbox's home folder.
const fakeChecks = (dir: string): ChecksShell => ({
  push: `tmp=${shellJoin([join(dir, ".deadline")])}.$$; printf "%s\\n" "$d" > "$tmp" && mv "$tmp" ${shellJoin([join(dir, "deadline")])} || { rm -f "$tmp"; false; }`,
  kills: `cat ${shellJoin([join(dir, "memory-kills")])}`,
  run: '"$@"',
});

export const makeFakeProvider = (options: {
  readonly fs: FileSystem.FileSystem;
  readonly root: string;
  readonly watch: "process" | "none";
  readonly login?: ProviderLogin | undefined;
  // Snapshots live in their own folder, one entry per Fingerprint; `fail`
  // makes a save ("push") or a start from one ("pull") fail.
  readonly snapshots?:
    | {
        readonly root: string;
        readonly fail?: "push" | "pull" | undefined;
      }
    | undefined;
  // A pretend region that never answers, named in `list`'s unreached.
  readonly unreached?: string | undefined;
  // When set, `list` itself fails unreachable — the reason it gives.
  readonly listDown?: string | undefined;
  // When set, create leaves a Max life file in the runtime dir, as Namespace
  // does, so auth logout finds the Sandboxes this machine started.
  readonly marksLocal?: boolean | undefined;
  // When set, delete of the Sandbox with this name fails unreachable.
  readonly deleteDown?: string | undefined;
  // When set, create stops after the Sandbox exists and before its Max
  // life file, until a file at this path exists: a create still running,
  // as a slow Namespace host makes one.
  readonly createHold?: string | undefined;
}): Provider => {
  const fs = options.fs;
  const root = options.root;
  const fail = (reason: string) =>
    new ProviderError({ provider: "fake", reason });
  // `unfinished`: the folder is there, but create never wrote its
  // sandbox.json, as a Namespace host with no Sandbox state.
  const gone = (name: string, unfinished?: true) =>
    new SandboxGoneError({ id: `fake:${name}`, unfinished });
  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));
  // Any error reads as "not there", as `existsSync` gives.
  const exists = (path: string) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false));

  // A fixed offline table stands in for a Provider's token check. The
  // fake has no regions; the region argument goes unused.
  const checkToken = Effect.fn("FakeProvider.checkToken")(function* (
    token: Redacted.Redacted<string>,
    _region: Option.Option<string>,
  ) {
    const known: Record<string, ProviderAccount> = {
      t0k: {
        account: "ada",
        expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      },
      t1k: {
        account: "bob",
        expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      },
    };
    const key = Redacted.value(token);
    const found = Object.hasOwn(known, key) ? known[key] : undefined;
    if (found === undefined) {
      return yield* new TokenRejectedError({ provider: "fake" });
    }
    return found;
  });

  const readFileInfo = Effect.fn("FakeProvider.readFileInfo")(function* (
    name: string,
  ) {
    if (!/^[a-z0-9]{6}$/.test(name)) {
      return yield* gone(name);
    }
    const dir = join(root, name);
    const text = yield* fs
      .readFileString(join(dir, "sandbox.json"))
      .pipe(
        Effect.catchAll((error) =>
          Effect.flatMap(exists(dir), (here) =>
            Effect.fail(
              !here
                ? gone(name)
                : error._tag === "SystemError" && error.reason === "NotFound"
                  ? gone(name, true)
                  : fail(describe(error)),
            ),
          ),
        ),
      );
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => fail(describe(cause)),
    });
    const file = yield* Schema.decodeUnknown(SandboxFile)(json).pipe(
      Effect.mapError((error) => fail(error.message)),
    );
    const seconds = yield* fs
      .readFileString(join(dir, "deadline"))
      .pipe(
        Effect.catchAll((error) =>
          Effect.flatMap(exists(dir), (here) =>
            Effect.fail(here ? fail(describe(error)) : gone(name)),
          ),
        ),
      );
    if (!/^[0-9]+\n?$/.test(seconds)) {
      return yield* fail(`could not read the Deadline: ${seconds.trim()}`);
    }
    const info = new SandboxInfo({
      name,
      os: file.os,
      createdAt: file.createdAt,
      idleSeconds: file.idleSeconds,
      deadline: new Date(Number(seconds.trim()) * 1000),
      maxLifeAt: file.maxLifeAt,
      size: file.size,
      snapshot: file.snapshot,
    });
    const current = yield* now;
    if (info.deadline.getTime() <= current.getTime()) {
      yield* fs
        .remove(dir, { recursive: true, force: true })
        .pipe(Effect.mapError((error) => fail(describe(error))));
      return yield* gone(name);
    }
    return info;
  });

  // Write a temp file and rename it over the file, so a concurrent read
  // sees the old file or the new one, never a half-written one.
  const writeWhole = Effect.fn("FakeProvider.writeWhole")(function* (
    path: string,
    text: string,
  ) {
    const temp = `${path}.${randomUUID()}.tmp`;
    yield* fs.writeFileString(temp, text).pipe(
      Effect.andThen(fs.rename(temp, path)),
      Effect.mapError((error) => fail(describe(error))),
      Effect.tapError(() =>
        fs.remove(temp, { force: true }).pipe(Effect.ignore),
      ),
    );
  });

  const writeFileInfo = (name: string, file: SandboxFile) =>
    writeWhole(
      join(root, name, "sandbox.json"),
      `${JSON.stringify(Schema.encodeSync(SandboxFile)(file))}\n`,
    );

  // The Deadline in its own file, in epoch seconds, as Docker keeps it.
  const writeDeadline = (name: string, deadline: Date) =>
    writeWhole(
      join(root, name, "deadline"),
      `${Math.floor(deadline.getTime() / 1000)}\n`,
    );

  const createWork = Effect.fn("FakeProvider.createWork")(function* (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly snapshot?: string | undefined;
  }) {
    const idleSeconds = yield* Schema.decodeUnknown(IdleSeconds)(
      Duration.toSeconds(req.idle),
    ).pipe(
      Effect.mapError(() =>
        fail(
          `idle must be a whole number of seconds above 0, got ${Duration.format(req.idle)}`,
        ),
      ),
    );
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError((error) => fail(describe(error))));
    let name: string | undefined;
    for (let i = 0; i < 5 && name === undefined; i++) {
      const candidate = makeSandboxName();
      const made = yield* fs.makeDirectory(join(root, candidate)).pipe(
        Effect.as(true),
        Effect.catchAll((error) =>
          error._tag === "SystemError" && error.reason === "AlreadyExists"
            ? Effect.succeed(false)
            : Effect.fail(fail(describe(error))),
        ),
      );
      if (made) name = candidate;
    }
    if (name === undefined) {
      return yield* fail("could not make a Sandbox name after 5 tries");
    }
    const dir = join(root, name);
    const createdAt = yield* now;
    const maxLifeAt = new Date(
      createdAt.getTime() + Duration.toMillis(req.maxLife),
    );
    // A missing Snapshot is not an error: the Sandbox starts empty and
    // the Setup script runs.
    const pullFails =
      req.snapshot !== undefined && options.snapshots?.fail === "pull";
    if (pullFails) {
      const progress = yield* Progress;
      yield* progress.warn(
        `could not pull the Snapshot (${fail("pull refused").message}); running the Setup script`,
      );
    }
    const saved =
      req.snapshot === undefined || options.snapshots === undefined || pullFails
        ? undefined
        : join(options.snapshots.root, req.snapshot);
    const entry =
      saved !== undefined && (yield* exists(saved)) ? saved : undefined;
    const file = new SandboxFile({
      os: req.os,
      createdAt,
      idleSeconds,
      maxLifeAt,
      size: req.size,
      snapshot: entry === undefined ? undefined : req.snapshot,
    });
    const deadline = nextDeadline({
      now: createdAt,
      idle: req.idle,
      maxLifeAt,
    });
    // The Deadline file first, so a Sandbox with a sandbox.json has one.
    yield* writeDeadline(name, deadline);
    yield* writeFileInfo(name, file);
    const hold = options.createHold;
    if (hold !== undefined) {
      yield* exists(hold).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(50)),
          until: (released) => released,
        }),
      );
    }
    if (options.marksLocal === true) {
      const maxLife = (yield* keeperPaths({ provider: "fake", name })).maxLife;
      yield* fs
        .writeFileString(
          maxLife,
          String(Math.floor(maxLifeAt.getTime() / 1000)),
          { mode: 0o600 },
        )
        .pipe(Effect.mapError((error) => fail(describe(error))));
    }
    yield* Effect.all(
      [
        fs.makeDirectory(join(dir, "home")),
        fs.makeDirectory(join(dir, "state")),
        fs.makeDirectory(join(dir, "secrets"), { mode: 0o700 }),
      ],
      { discard: true },
    ).pipe(Effect.mapError((error) => fail(describe(error))));
    if (entry !== undefined) {
      yield* Effect.all(
        [
          fs.copy(join(entry, "home"), join(dir, "home")),
          fs.copy(join(entry, "state"), join(dir, "state")),
        ],
        { discard: true },
      ).pipe(Effect.mapError((error) => fail(describe(error))));
    }
    if (options.watch === "process") {
      yield* spawnDetached("fake", "fake/watch-main", [root, name]);
    }
    return new SandboxInfo({ name, ...file, deadline });
  });

  const create = Effect.fn("FakeProvider.create")(function* (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly snapshot?: string | undefined;
  }) {
    const login = yield* options.login ?? Effect.void;
    // The fake stands in for a real Provider, which rejects a bad
    // token at its API — a rejected login makes no Sandbox.
    if (login !== undefined) {
      yield* checkToken(login.token, login.region);
    }
    return yield* Effect.flatMap(Progress, (progress) =>
      progress.step("creating fake Sandbox", createWork(req)),
    );
  });

  const get = (sandbox: SandboxRef) => readFileInfo(sandbox.name);

  const list = Effect.gen(function* () {
    if (options.listDown !== undefined) {
      return yield* new ProviderUnavailableError({
        provider: "fake",
        reason: options.listDown,
      });
    }
    const entries = yield* fs
      .readDirectory(root)
      .pipe(
        Effect.catchAll((error) =>
          error._tag === "SystemError" && error.reason === "NotFound"
            ? Effect.succeed([])
            : Effect.fail(fail(describe(error))),
        ),
      );
    // `readDirectory` gives names only; a name whose stat fails is a folder
    // already gone.
    const names = yield* Effect.filter(entries, (name) =>
      fs.stat(join(root, name)).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ),
    );
    // The fake has only Linux; a folder's mtime stands in for when the
    // create started, so a test can age it.
    const unfinished: Array<UnfinishedSandbox> = [];
    const infos = yield* Effect.forEach(
      names,
      (name) =>
        readFileInfo(name).pipe(
          Effect.catchTag("SandboxGoneError", (error) =>
            error.unfinished === true
              ? fs.stat(join(root, name)).pipe(
                  Effect.map((info) => Option.getOrUndefined(info.mtime)),
                  Effect.orElseSucceed(() => undefined),
                  Effect.map((createdAt) => {
                    unfinished.push({ name, os: "linux", createdAt });
                    return undefined;
                  }),
                )
              : Effect.succeed(undefined),
          ),
        ),
      { discard: false },
    ).pipe(Effect.map((infos) => infos.filter((info) => info !== undefined)));
    const unreached =
      options.unreached === undefined
        ? []
        : [
            {
              where: `fake region ${options.unreached}`,
              reason: `fake region ${options.unreached} did not answer`,
            },
          ];
    return { infos, unreached, unfinished };
  });

  const del = Effect.fn("FakeProvider.del")(function* (sandbox: SandboxRef) {
    const name = sandbox.name;
    if (name === options.deleteDown) {
      return yield* new ProviderUnavailableError({
        provider: "fake",
        reason: `fake Sandbox ${name} did not answer`,
      });
    }
    // The Max life file goes with the Sandbox, whether it was still
    // there or already gone, as Namespace drops its runtime files.
    const unmark =
      options.marksLocal === true
        ? Effect.flatMap(keeperPaths({ provider: "fake", name }), (paths) =>
            fs.remove(paths.maxLife, { force: true }).pipe(Effect.ignore),
          )
        : Effect.void;
    // An Unfinished Sandbox is there to delete, as its Namespace host is.
    const present = yield* readFileInfo(name).pipe(
      Effect.map(() => true),
      Effect.catchTag("SandboxGoneError", (error) =>
        Effect.succeed(error.unfinished === true),
      ),
    );
    if (!present) {
      yield* unmark;
      return "gone" as const;
    }
    yield* fs
      .remove(join(root, name), { recursive: true, force: true })
      .pipe(Effect.mapError((error) => fail(describe(error))));
    yield* unmark;
    return "deleted" as const;
  });

  const extend = Effect.fn("FakeProvider.extend")(function* (
    sandbox: SandboxRef,
    deadline: Date,
  ) {
    yield* readFileInfo(sandbox.name);
    yield* writeDeadline(sandbox.name, deadline);
  });

  // Copy into a temp entry and rename it over the old one, so a create
  // that starts from the Snapshot never sees a half-written one.
  const saveSnapshot = Effect.fn("FakeProvider.saveSnapshot")(function* (
    sandbox: SandboxRef,
    fingerprint: string,
  ) {
    const name = sandbox.name;
    const snapshots = options.snapshots;
    if (snapshots === undefined) {
      return yield* fail("this fake Provider keeps no Snapshots");
    }
    if (snapshots.fail === "push") {
      return yield* fail("push refused");
    }
    yield* readFileInfo(name);
    const dir = join(root, name);
    const entry = join(snapshots.root, fingerprint);
    const temp = join(snapshots.root, `.new-${fingerprint}`);
    yield* Effect.all(
      [
        fs.remove(temp, { recursive: true, force: true }),
        fs.makeDirectory(temp, { recursive: true }),
        fs.copy(join(dir, "home"), join(temp, "home")),
        fs.copy(join(dir, "state"), join(temp, "state")),
        fs.remove(entry, { recursive: true, force: true }),
        fs.rename(temp, entry),
      ],
      { discard: true },
    ).pipe(
      Effect.mapError((error) => fail(describe(error))),
      Effect.tapError(() =>
        fs.remove(temp, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  const connect = Effect.fn("FakeProvider.connect")(function* (
    sandbox: SandboxRef,
  ) {
    const executor = yield* CommandExecutor.CommandExecutor;
    const dir = join(root, sandbox.name);
    const info = yield* get(sandbox);
    const connection: Connection = {
      info,
      get: get(sandbox),
      extend: (deadline) => extend(sandbox, deadline),
      // The fake's Sandbox is a folder on the Caller's machine: the command
      // run's script runs in a local `sh` in its home folder (ADR 0015).
      transport: {
        shell: fakeChecks(dir),
        call: (argv, options) =>
          commandEvents(
            executor,
            Command.make(argv[0] ?? "sh", ...argv.slice(1)).pipe(
              Command.workingDirectory(join(dir, "home")),
            ),
            options,
            {
              // No Sandbox folder means the Sandbox is gone, as Docker's
              // "No such container" is.
              spawn: (error) =>
                existsSync(dir) ? fail(error.message) : gone(sandbox.name),
              fail: (reason) => fail(reason),
            },
          ),
        gone: () => gone(sandbox.name),
        fail: (reason) => fail(reason),
      },
    };
    return connection;
  });

  return {
    name: "fake",
    idPrefix: "fake",
    loginFiles: [],
    login: {
      _tag: "Ways",
      checkToken,
    },
    offers: {
      linux: {
        sizes: [
          { cpu: 4, ramGb: 8 },
          { cpu: 8, ramGb: 16 },
          { cpu: 16, ramGb: 32 },
        ],
        features: new Set(
          options.snapshots === undefined
            ? ["secrets"]
            : ["secrets", "snapshot"],
        ),
      },
    },
    create,
    ...(options.snapshots === undefined
      ? {}
      : {
          snapshots: {
            baseVersion: Effect.succeed("fake"),
            save: saveSnapshot,
          },
        }),
    get,
    list,
    delete: del,
    extend,
    // The fake runs on the Caller's machine, where the env file already
    // is; its Secrets folder (mode 0700) is on disk, not a tmpfs, until delete.
    sandboxFolders: (name) => ({
      state: join(root, name, "state"),
      secrets: join(root, name, "secrets"),
    }),
    connect,
  };
};
