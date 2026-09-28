import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { Clock, Duration, Effect, Schema, Stream } from "effect";
import { nextDeadline } from "../deadline.ts";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import { Progress } from "../progress.ts";
import {
  type Capability,
  type Connection,
  type ExecEvent,
  IdleSeconds,
  Os,
  type Provider,
  SandboxInfo,
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
  readonly snapshots?:
    | {
        readonly root: string;
        readonly fail?: "push" | "pull" | undefined;
      }
    | undefined;
}): Provider => {
  const root = options.root;
  const fail = (reason: string) =>
    new ProviderError({ provider: "fake", reason });
  const gone = (name: string) => new SandboxGoneError({ id: `fake:${name}` });
  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

  const readFileInfo = (name: string) =>
    Effect.gen(function* () {
      if (!/^[a-z0-9]{6}$/.test(name)) {
        return yield* gone(name);
      }
      const dir = join(root, name);
      const text = yield* Effect.tryPromise({
        try: () => readFile(join(dir, "sandbox.json"), "utf8"),
        catch: (cause) =>
          !existsSync(dir) || hasCode(cause, "ENOENT")
            ? gone(name)
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
  const writeFileInfo = (name: string, file: SandboxFile) =>
    Effect.gen(function* () {
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
          Effect.tryPromise(() => rm(temp, { force: true })).pipe(
            Effect.ignore,
          ),
        ),
      );
    });

  const createWork = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly snapshot?: string | undefined;
  }) =>
    Effect.gen(function* () {
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
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(join(dir, "home"));
          await mkdir(join(dir, "state"));
          await mkdir(join(dir, "secrets"), { mode: 0o700 });
        },
        catch: (cause) => fail(describe(cause)),
      });
      let pulled: string | undefined;
      if (options.snapshots !== undefined && req.snapshot !== undefined) {
        if (options.snapshots.fail === "pull") {
          const progress = yield* Progress;
          yield* progress.warn(
            `could not pull the Snapshot (${fail("pull refused").message}); running the Setup script`,
          );
        } else {
          const entry = join(options.snapshots.root, req.snapshot);
          const found = yield* Effect.tryPromise({
            try: async () => {
              if (!existsSync(entry)) {
                return false;
              }
              await cp(join(entry, "home"), join(dir, "home"), {
                recursive: true,
              });
              await cp(join(entry, "state"), join(dir, "state"), {
                recursive: true,
              });
              return true;
            },
            catch: (cause) => fail(describe(cause)),
          });
          if (found) {
            pulled = req.snapshot;
          }
        }
      }
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
        snapshot: pulled,
      });
      yield* writeFileInfo(name, file);
      if (options.watch === "process") {
        yield* spawnDetached("fake", "fake/watch-main", [root, name]);
      }
      return new SandboxInfo({ name, ...file });
    });

  const create = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly snapshot?: string | undefined;
  }) =>
    Effect.flatMap(Progress, (progress) =>
      progress.step("creating fake Sandbox", createWork(req)),
    );

  const get = (name: string) => readFileInfo(name);

  // A Snapshot keeps the Work folder and the state dir (the hash list the
  // next upload diffs against); the Secrets folder never leaves the Sandbox.
  // The staging dir lands on the same filesystem, so the rename is atomic.
  const saveSnapshot = (name: string, fp: string) =>
    Effect.gen(function* () {
      const snapshots = options.snapshots;
      if (snapshots === undefined) {
        return;
      }
      if (snapshots.fail === "push") {
        return yield* fail("push refused");
      }
      yield* Effect.tryPromise({
        try: async () => {
          const dir = join(root, name);
          const staging = join(snapshots.root, `.new-${fp}`);
          const target = join(snapshots.root, fp);
          await rm(staging, { recursive: true, force: true });
          await mkdir(staging, { recursive: true });
          await cp(join(dir, "home"), join(staging, "home"), {
            recursive: true,
          });
          await cp(join(dir, "state"), join(staging, "state"), {
            recursive: true,
          });
          await rm(target, { recursive: true, force: true });
          await rename(staging, target);
        },
        catch: (cause) => fail(describe(cause)),
      });
    });

  const list = Effect.gen(function* () {
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
    return yield* Effect.forEach(
      names,
      (name) =>
        readFileInfo(name).pipe(
          Effect.catchTag("SandboxGoneError", () => Effect.succeed(undefined)),
        ),
      { discard: false },
    ).pipe(Effect.map((infos) => infos.filter((info) => info !== undefined)));
  });

  const del = (name: string) =>
    Effect.gen(function* () {
      const alive = yield* readFileInfo(name).pipe(
        Effect.map(() => true),
        Effect.catchTag("SandboxGoneError", () => Effect.succeed(false)),
      );
      if (!alive) {
        return "gone" as const;
      }
      yield* Effect.tryPromise({
        try: () => rm(join(root, name), { recursive: true, force: true }),
        catch: (cause) => fail(describe(cause)),
      });
      return "deleted" as const;
    });

  const extend = (name: string, deadline: Date) =>
    Effect.gen(function* () {
      const info = yield* readFileInfo(name);
      const file = new SandboxFile({
        os: info.os,
        createdAt: info.createdAt,
        idleSeconds: info.idleSeconds,
        deadline,
        maxLifeAt: info.maxLifeAt,
        size: info.size,
        snapshot: info.snapshot,
      });
      yield* writeFileInfo(name, file);
    });

  const connect = (name: string) =>
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const home = join(root, name, "home");
      yield* get(name);
      const connection: Connection = {
        exec: (argv, options) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              const process = yield* Command.start(
                Command.make("sh", "-c", shellJoin(argv)).pipe(
                  Command.workingDirectory(home),
                ),
              ).pipe(
                Effect.provideService(
                  CommandExecutor.CommandExecutor,
                  executor,
                ),
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
          ),
      };
      return connection;
    });

  return {
    name: "fake",
    idPrefix: "fake",
    capabilities: new Set<Capability>(
      options.snapshots === undefined
        ? ["os:linux"]
        : ["os:linux", "snapshot"],
    ),
    sizes: [
      { cpu: 4, ramGb: 8 },
      { cpu: 8, ramGb: 16 },
      { cpu: 16, ramGb: 32 },
    ],
    create,
    get,
    ...(options.snapshots === undefined
      ? {}
      : {
          snapshots: {
            baseVersion: Effect.succeed("fake"),
            save: saveSnapshot,
          },
        }),
    list,
    delete: del,
    extend,
    stateDir: (name) => join(root, name, "state"),
    // The fake runs on the Caller's machine, where the env file already
    // is; its Secrets folder (mode 0700) is on disk, not a tmpfs, until delete.
    secretsDir: (name) => join(root, name, "secrets"),
    connect,
    memoryKills: () => Effect.succeed(0),
  };
};
