import { Command, CommandExecutor } from "@effect/platform";
import { Chunk, Effect, Option, Stream } from "effect";
import { ProviderError, ProviderUnavailableError } from "../errors.ts";
import type { ExecEvent } from "../provider.ts";

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerInspection {
  readonly labels: unknown;
  readonly running: boolean;
}

export type DockerError = ProviderError | ProviderUnavailableError;

export interface DockerClient {
  readonly serverArch: Effect.Effect<string, DockerError>;
  readonly imageExists: (tag: string) => Effect.Effect<boolean, DockerError>;
  readonly build: (image: {
    readonly dir: string;
    readonly tag: string;
    readonly buildArgs: Readonly<Record<string, string>>;
  }) => Effect.Effect<void, DockerError>;
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<DockerExecResult, DockerError>;
  readonly execText: (
    container: string,
    user: string,
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<DockerExecResult, DockerError>;
  readonly execStream: (
    container: string,
    argv: ReadonlyArray<string>,
  ) => Stream.Stream<ExecEvent, DockerError>;
  readonly inspect: (
    container: string,
  ) => Effect.Effect<Option.Option<DockerInspection>, DockerError>;
  readonly listNames: Effect.Effect<ReadonlyArray<string>, DockerError>;
  readonly remove: (container: string) => Effect.Effect<void, DockerError>;
}

const DOCKER_DOWN = [
  "Cannot connect to the Docker daemon",
  "failed to connect to the docker API",
];

const tail = (text: string, lines: number) =>
  text.trim().split("\n").slice(-lines).join("\n");

const isDown = (result: { readonly stdout: string; readonly stderr: string }) =>
  DOCKER_DOWN.some(
    (hint) => result.stderr.includes(hint) || result.stdout.includes(hint),
  );

const toText = (chunks: Chunk.Chunk<Uint8Array>) =>
  Buffer.concat(Chunk.toReadonlyArray(chunks).map((bytes) => bytes)).toString(
    "utf8",
  );

export const makeDockerClient = (
  executor: CommandExecutor.CommandExecutor,
): DockerClient => {
  const unavailable = () =>
    new ProviderUnavailableError({
      provider: "docker",
      reason: "Docker is not running; start Docker and try again",
    });
  const fail = (reason: string) =>
    new ProviderError({ provider: "docker", reason });
  const describe = (cause: unknown) =>
    cause instanceof Error ? cause.message : String(cause);

  // A missing `docker` binary is a spawn ENOENT (SystemError "NotFound"); a
  // stopped daemon answers every call with DOCKER_DOWN.
  const spawnError = (error: {
    readonly _tag: string;
    readonly reason?: unknown;
    readonly message: string;
  }) =>
    error._tag === "SystemError" && error.reason === "NotFound"
      ? unavailable()
      : fail(error.message);

  const refuse = (what: string, result: DockerExecResult) =>
    isDown(result)
      ? Effect.fail(unavailable())
      : Effect.fail(
          fail(`${what}: ${tail(result.stderr + result.stdout, 20)}`),
        );

  const capture = (
    argv: ReadonlyArray<string>,
  ): Effect.Effect<DockerExecResult, DockerError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* Command.start(
          Command.make("docker", ...argv),
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.mapError((error) => spawnError(error)),
        );
        const [outBytes, errBytes, exitCode] = yield* Effect.all(
          [
            Stream.runCollect(process.stdout),
            Stream.runCollect(process.stderr),
            process.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((error) => fail(describe(error))));
        return {
          exitCode,
          stdout: toText(outBytes),
          stderr: toText(errBytes),
        } satisfies DockerExecResult;
      }),
    );

  const serverArch = Effect.gen(function* () {
    const result = yield* capture(["version", "--format", "{{.Server.Arch}}"]);
    if (result.exitCode !== 0) {
      return yield* refuse("docker version failed", result);
    }
    return result.stdout.trim();
  });

  const imageExists = (tag: string) =>
    Effect.gen(function* () {
      const result = yield* capture(["image", "inspect", tag]);
      if (result.exitCode === 0) {
        return true;
      }
      if (isDown(result)) {
        return yield* unavailable();
      }
      return false;
    });

  const build = (image: {
    readonly dir: string;
    readonly tag: string;
    readonly buildArgs: Readonly<Record<string, string>>;
  }) =>
    Effect.gen(function* () {
      const args = ["build", "--progress=plain", "-t", image.tag];
      for (const [key, value] of Object.entries(image.buildArgs)) {
        args.push("--build-arg", `${key}=${value}`);
      }
      args.push(image.dir);
      const result = yield* capture(args);
      if (result.exitCode !== 0) {
        return yield* refuse("docker build failed", result);
      }
    });

  const run = (args: ReadonlyArray<string>) => capture(["run", "-d", ...args]);

  const execText = (
    container: string,
    user: string,
    argv: ReadonlyArray<string>,
  ) => capture(["exec", "-u", user, container, ...argv]);

  const execStream = (
    container: string,
    argv: ReadonlyArray<string>,
  ): Stream.Stream<ExecEvent, DockerError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const process = yield* Command.start(
          Command.make(
            "docker",
            "exec",
            "-u",
            "app",
            "-w",
            "/home/app",
            container,
            ...argv,
          ),
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.mapError((error) => spawnError(error)),
        );
        const events = Stream.merge(
          process.stdout.pipe(
            Stream.map((bytes): ExecEvent => ({ _tag: "Stdout", bytes })),
          ),
          process.stderr.pipe(
            Stream.map((bytes): ExecEvent => ({ _tag: "Stderr", bytes })),
          ),
        ).pipe(Stream.mapError((error) => fail(describe(error))));
        const exit = Stream.fromEffect(
          process.exitCode.pipe(
            Effect.mapError((error) => fail(describe(error))),
          ),
        ).pipe(Stream.map((code): ExecEvent => ({ _tag: "Exit", code })));
        return Stream.concat(events, exit);
      }),
    );

  const inspect = (container: string) =>
    Effect.gen(function* () {
      const result = yield* capture([
        "inspect",
        container,
        "--format",
        "{{json .Config.Labels}}|{{.State.Running}}",
      ]);
      if (result.exitCode !== 0) {
        if (isDown(result)) {
          return yield* unavailable();
        }
        if (result.stderr.includes("No such object")) {
          return Option.none();
        }
        return yield* refuse("docker inspect failed", result);
      }
      const text = result.stdout.trim();
      const separator = text.lastIndexOf("|");
      if (separator === -1) {
        return yield* fail(`bad docker inspect output: ${text}`);
      }
      const labels = yield* Effect.try({
        try: () => JSON.parse(text.slice(0, separator)) as unknown,
        catch: (cause) => fail(describe(cause)),
      });
      return Option.some({
        labels,
        running: text.slice(separator + 1) === "true",
      });
    });

  const listNames = Effect.gen(function* () {
    const result = yield* capture([
      "ps",
      "--filter",
      "label=proofbox.name",
      "--format",
      '{{.Label "proofbox.name"}}',
    ]);
    if (result.exitCode !== 0) {
      return yield* refuse("docker ps failed", result);
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  });

  const remove = (container: string) =>
    Effect.gen(function* () {
      const result = yield* capture(["rm", "-f", container]);
      if (result.exitCode !== 0) {
        return yield* refuse("docker rm failed", result);
      }
    });

  return {
    serverArch,
    imageExists,
    build,
    run,
    execText,
    execStream,
    inspect,
    listNames,
    remove,
  };
};
