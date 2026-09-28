import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { Clock, Duration, Effect, Schema, Stream } from "effect";
import { nextDeadline } from "../deadline.ts";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import { Progress } from "../progress.ts";
import {
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

  const writeFileInfo = (name: string, file: SandboxFile) =>
    Effect.tryPromise({
      try: () =>
        writeFile(
          join(root, name, "sandbox.json"),
          `${JSON.stringify(Schema.encodeSync(SandboxFile)(file))}\n`,
        ),
      catch: (cause) => fail(describe(cause)),
    });

  const createWork = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size;
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
      });
      yield* writeFileInfo(name, file);
      yield* Effect.tryPromise({
        try: () => mkdir(join(dir, "home")),
        catch: (cause) => fail(describe(cause)),
      });
      if (options.watch === "process") {
        yield* spawnDetached("fake", "fake/watch-main", [root, name]);
      }
      return new SandboxInfo({ name, ...file });
    });

  const create = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size;
  }) =>
    Effect.flatMap(Progress, (progress) =>
      progress.step("creating fake Sandbox", createWork(req)),
    );

  const get = (name: string) => readFileInfo(name);

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
      });
      yield* writeFileInfo(name, file);
      return yield* readFileInfo(name);
    });

  const connect = (name: string) =>
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const home = join(root, name, "home");
      yield* get(name);
      const connection: Connection = {
        exec: (argv) =>
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
              const events = Stream.merge(
                process.stdout.pipe(
                  Stream.map((bytes): ExecEvent => ({ _tag: "Stdout", bytes })),
                ),
                process.stderr.pipe(
                  Stream.map((bytes): ExecEvent => ({ _tag: "Stderr", bytes })),
                ),
              ).pipe(Stream.mapError((error) => fail(error.message)));
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
    capabilities: new Set(["os:linux"]),
    sizes: [
      { cpu: 4, ramGb: 8 },
      { cpu: 8, ramGb: 16 },
      { cpu: 16, ramGb: 32 },
    ],
    create,
    get,
    list,
    delete: del,
    extend,
    connect,
  };
};
