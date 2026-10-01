import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import {
  Clock,
  Duration,
  Effect,
  type Option,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { nextDeadline, pushedDeadline } from "../deadline.ts";
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
  type ExecEvent,
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
  deadline: Schema.Date,
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

export const makeFakeProvider = (options: {
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
  const root = options.root;
  const fail = (reason: string) =>
    new ProviderError({ provider: "fake", reason });
  // `unfinished`: the folder is there, but create never wrote its
  // sandbox.json, as a Namespace host with no Sandbox state.
  const gone = (name: string, unfinished?: true) =>
    new SandboxGoneError({ id: `fake:${name}`, unfinished });
  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

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
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(dir, "sandbox.json"), "utf8"),
      catch: (cause) =>
        !existsSync(dir)
          ? gone(name)
          : hasCode(cause, "ENOENT")
            ? gone(name, true)
            : fail(describe(cause)),
    });
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => fail(describe(cause)),
    });
    const file = yield* Schema.decodeUnknown(SandboxFile)(json).pipe(
      Effect.mapError((error) => fail(error.message)),
    );
    const info = new SandboxInfo({
      name,
      os: file.os,
      createdAt: file.createdAt,
      idleSeconds: file.idleSeconds,
      deadline: file.deadline,
      maxLifeAt: file.maxLifeAt,
      size: file.size,
      snapshot: file.snapshot,
    });
    const current = yield* now;
    if (info.deadline.getTime() <= current.getTime()) {
      yield* Effect.tryPromise({
        try: () => rm(dir, { recursive: true, force: true }),
        catch: (cause) => fail(describe(cause)),
      });
      return yield* gone(name);
    }
    return info;
  });

  // Write a temp file and rename it over sandbox.json, so a concurrent read
  // sees the old file or the new one, never a half-written one.
  const writeFileInfo = Effect.fn("FakeProvider.writeFileInfo")(function* (
    name: string,
    file: SandboxFile,
  ) {
    const path = join(root, name, "sandbox.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(
          temp,
          `${JSON.stringify(Schema.encodeSync(SandboxFile)(file))}\n`,
        );
        await rename(temp, path);
      },
      catch: (cause) => fail(describe(cause)),
    }).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() => rm(temp, { force: true })).pipe(Effect.ignore),
      ),
    );
  });

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
      deadline: nextDeadline({
        now: createdAt,
        idle: req.idle,
        maxLifeAt,
      }),
      maxLifeAt,
      size: req.size,
      snapshot: entry === undefined ? undefined : req.snapshot,
    });
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
    return new SandboxInfo({ name, ...file });
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
    const info = yield* readFileInfo(sandbox.name);
    const file = new SandboxFile({
      os: info.os,
      createdAt: info.createdAt,
      idleSeconds: info.idleSeconds,
      deadline,
      maxLifeAt: info.maxLifeAt,
      size: info.size,
      snapshot: info.snapshot,
    });
    yield* writeFileInfo(sandbox.name, file);
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
    const home = join(root, sandbox.name, "home");
    const info = yield* get(sandbox);
    // The fake's commands run on the Caller's machine and its Deadline is
    // a JSON file, so its checks run in-process. It sees no memory kills, so
    // its Exit carries no counts.
    const push = Effect.flatMap(pushedDeadline(info), (deadline) =>
      extend(sandbox, deadline),
    );
    const run = (
      argv: ReadonlyArray<string>,
      options: Parameters<Connection["exec"]>[1],
    ) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const process = yield* Command.start(
            Command.make("sh", "-c", shellJoin(argv)).pipe(
              Command.workingDirectory(home),
            ),
          ).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.mapError((error) => fail(error.message)),
          );
          const feed =
            options?.stdin === undefined
              ? undefined
              : Stream.run(options.stdin, process.stdin).pipe(
                  // A command may exit before its stdin reports "finish"
                  // (tar -x stops at the end-of-archive marker); when the
                  // process is gone the feed is done by definition.
                  Effect.raceFirst(
                    process.exitCode.pipe(Effect.orElseSucceed(() => {})),
                  ),
                  Effect.mapError((error) => fail(error.message)),
                );
          const outputs = Stream.merge(
            process.stdout.pipe(
              Stream.map((bytes): ExecEvent => ({ _tag: "Stdout", bytes })),
            ),
            process.stderr.pipe(
              Stream.map((bytes): ExecEvent => ({ _tag: "Stderr", bytes })),
            ),
          ).pipe(Stream.mapError((error) => fail(error.message)));
          const events =
            feed === undefined
              ? outputs
              : Stream.merge(
                  outputs,
                  Stream.fromEffect(feed).pipe(Stream.drain),
                );
          const exit = Stream.fromEffect(
            process.exitCode.pipe(
              Effect.mapError((error) => fail(error.message)),
            ),
          ).pipe(Stream.map((code): ExecEvent => ({ _tag: "Exit", code })));
          return Stream.concat(events, exit);
        }),
      );
    const connection: Connection = {
      info,
      get: get(sandbox),
      extend: (deadline) => extend(sandbox, deadline),
      exec: (argv, options) =>
        Stream.concat(
          Stream.fromEffect(push).pipe(Stream.drain),
          run(argv, options).pipe(
            Stream.tap((event) => (event._tag === "Exit" ? push : Effect.void)),
          ),
        ),
    };
    return connection;
  });

  return {
    name: "fake",
    idPrefix: "fake",
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
    stateDir: (name) => join(root, name, "state"),
    // The fake runs on the Caller's machine, where the env file already
    // is; its Secrets folder (mode 0700) is on disk, not a tmpfs, until delete.
    secretsDir: (name) => join(root, name, "secrets"),
    connect,
  };
};
