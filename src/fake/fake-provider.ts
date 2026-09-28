import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { Config, Effect, Layer, Schema, Stream } from "effect";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import {
  type Connection,
  type ExecEvent,
  Os,
  type Provider,
  Providers,
  SandboxInfo,
} from "../provider.ts";
import { shellJoin } from "../shell.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const makeName = () =>
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );

class SandboxFile extends Schema.Class<SandboxFile>("SandboxFile")({
  os: Os,
  createdAt: Schema.Date,
}) {}

const describe = (cause: unknown) =>
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

  const create = (req: { readonly os: Os }) =>
    Effect.gen(function* () {
      let name: string | undefined;
      for (let i = 0; i < 5 && name === undefined; i++) {
        const candidate = makeName();
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
      const info = new SandboxInfo({
        name,
        os: req.os,
        createdAt: new Date(),
      });
      const file = new SandboxFile({ os: info.os, createdAt: info.createdAt });
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(
            join(dir, "sandbox.json"),
            `${JSON.stringify(Schema.encodeSync(SandboxFile)(file))}\n`,
          );
          await mkdir(join(dir, "home"));
        },
        catch: (cause) => fail(describe(cause)),
      });
      return info;
    });

  const get = (name: string) =>
    Effect.gen(function* () {
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
      return new SandboxInfo({
        name,
        os: file.os,
        createdAt: file.createdAt,
      });
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
    create,
    get,
    connect,
  };
};

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const root = yield* Config.string("PROOFBOX_FAKE_ROOT").pipe(
      Config.withDefault(join(homedir(), ".local/share/proofbox/fake")),
    );
    const providers = new Map<string, Provider>([
      ["fake", makeFakeProvider({ root, watch: "process" })],
    ]);
    return providers;
  }),
);
