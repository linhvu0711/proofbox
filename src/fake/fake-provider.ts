import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor, type FileSystem } from "@effect/platform";
import {
  Clock,
  Duration,
  Effect,
  type Option,
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

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

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
    yield* Effect.tryPromise({
      try: () => mkdir(root, { recursive: true }),
      catch: (cause) => fail(describe(cause)),
    });
    let name: string | undefined;
    for (let i = 0; i < 5 && name === undefined; i++) {
      const candidate = makeSandboxName();
      const made = yield* Effect.tryPromise({
        try: async () => {
          await mkdir(join(root, candidate));
          return true;
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          hasCode(cause, "EEXIST")
            ? Effect.succeed(false)
            : Effect.fail(fail(describe(cause))),
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
    const entry = saved !== undefined && existsSync(saved) ? saved : undefined;
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
      yield* Effect.sync(() => existsSync(hold)).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(50)),
          until: (released) => released,
        }),
      );
    }
    if (options.marksLocal === true) {
      const maxLife = (yield* keeperPaths({ provider: "fake", name })).maxLife;
      yield* Effect.tryPromise({
        try: () =>
          writeFile(maxLife, String(Math.floor(maxLifeAt.getTime() / 1000)), {
            mode: 0o600,
          }),
        catch: (cause) => fail(describe(cause)),
      });
    }
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(join(dir, "home"));
        await mkdir(join(dir, "state"));
        await mkdir(join(dir, "secrets"), { mode: 0o700 });
      },
      catch: (cause) => fail(describe(cause)),
    });
    if (entry !== undefined) {
      yield* Effect.tryPromise({
        try: async () => {
          await cp(join(entry, "home"), join(dir, "home"), {
            recursive: true,
          });
          await cp(join(entry, "state"), join(dir, "state"), {
            recursive: true,
          });
        },
        catch: (cause) => fail(describe(cause)),
      });
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
    const entries = yield* Effect.tryPromise({
      try: () =>
        readdir(root, { withFileTypes: true }).catch((cause) =>
          hasCode(cause, "ENOENT")
            ? Promise.resolve([])
            : Promise.reject(cause),
        ),
      catch: (cause) => fail(describe(cause)),
    });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    // The fake has only Linux; a folder's mtime stands in for when the
    // create started, so a test can age it.
    const unfinished: Array<UnfinishedSandbox> = [];
    const infos = yield* Effect.forEach(
      names,
      (name) =>
        readFileInfo(name).pipe(
          Effect.catchTag("SandboxGoneError", (error) =>
            error.unfinished === true
              ? Effect.promise(() =>
                  stat(join(root, name)).then(
                    (info) => info.mtime,
                    () => undefined,
                  ),
                ).pipe(
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
            Effect.promise(() =>
              rm(paths.maxLife, { force: true }).catch(() => {}),
            ),
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
    yield* Effect.tryPromise({
      try: () => rm(join(root, name), { recursive: true, force: true }),
      catch: (cause) => fail(describe(cause)),
    });
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
    yield* Effect.tryPromise({
      try: async () => {
        await rm(temp, { recursive: true, force: true });
        await mkdir(temp, { recursive: true });
        await cp(join(dir, "home"), join(temp, "home"), { recursive: true });
        await cp(join(dir, "state"), join(temp, "state"), {
          recursive: true,
        });
        await rm(entry, { recursive: true, force: true });
        await rename(temp, entry);
      },
      catch: (cause) => fail(describe(cause)),
    }).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() =>
          rm(temp, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
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
