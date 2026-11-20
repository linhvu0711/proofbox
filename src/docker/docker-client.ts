import { Command, CommandExecutor } from "@effect/platform";
import { Effect, Option, Stream } from "effect";
import { commandEvents, toText } from "../command-events.ts";
import {
  causeText,
  type LinkDroppedError,
  ProviderError,
  ProviderUnavailableError,
  type SandboxGoneError,
} from "../errors.ts";
import type { Link } from "../namespace/ssh-link.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";
import { shellJoin } from "../shell.ts";

interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerInspection {
  readonly labels: unknown;
  readonly running: boolean;
}

export type DockerError = ProviderError | ProviderUnavailableError;

export interface DockerClient {
  readonly serverArch: Effect.Effect<string, DockerError>;
  readonly imageExists: (tag: string) => Effect.Effect<boolean, DockerError>;
  readonly pull: (tag: string) => Effect.Effect<boolean, DockerError>;
  readonly push: (tag: string) => Effect.Effect<void, DockerError>;
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
  // `user` is `app` unless a caller drops to it itself.
  readonly execStream: (
    container: string,
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
    user?: "app" | "root",
  ) => Stream.Stream<
    ExecEvent,
    DockerError | SandboxGoneError | LinkDroppedError
  >;
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

export const makeDockerClient = (
  executor: CommandExecutor.CommandExecutor,
  // A Namespace host's link: every docker line but a build goes through
  // its `run` and `stream`, which open the link again when it dropped.
  remote?: Link,
): DockerClient => {
  const provider = remote === undefined ? "docker" : "namespace";
  const linkLost = (detail: string) =>
    new ProviderUnavailableError({
      provider: "namespace",
      reason: `lost the link to the Namespace host: ${detail}`,
    });
  const unavailable = () =>
    remote === undefined
      ? new ProviderUnavailableError({
          provider: "docker",
          reason: "Docker is not running; start Docker and try again",
        })
      : linkLost("the link was already gone");
  const fail = (reason: string) => new ProviderError({ provider, reason });

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
    remote !== undefined
      ? remote
          .run(shellJoin(["docker", ...argv]))
          .pipe(
            Effect.catchTag("SandboxGoneError", (error) =>
              Effect.fail(fail(error.message)),
            ),
          )
      : captureLocal(argv);

  const captureLocal = (
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
        ).pipe(Effect.mapError((error) => fail(causeText(error))));
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

  const imageExists = Effect.fn("DockerClient.imageExists")(function* (
    tag: string,
  ) {
    const result = yield* capture(["image", "inspect", tag]);
    if (result.exitCode === 0) {
      return true;
    }
    if (isDown(result)) {
      return yield* unavailable();
    }
    return false;
  });

  const pull = Effect.fn("DockerClient.pull")(function* (tag: string) {
    const result = yield* capture(["pull", tag]);
    if (result.exitCode === 0) {
      return true;
    }
    if (isDown(result)) {
      return yield* unavailable();
    }
    return false;
  });

  const push = Effect.fn("DockerClient.push")(function* (tag: string) {
    const result = yield* capture(["push", tag]);
    if (result.exitCode !== 0) {
      return yield* refuse("docker push failed", result);
    }
  });

  const build = Effect.fn("DockerClient.build")(function* (image: {
    readonly dir: string;
    readonly tag: string;
    readonly buildArgs: Readonly<Record<string, string>>;
  }) {
    const args = ["build", "--progress=plain", "-t", image.tag];
    for (const [key, value] of Object.entries(image.buildArgs)) {
      args.push("--build-arg", `${key}=${value}`);
    }
    if (remote !== undefined) {
      // The remote host cannot see the local context directory; stream a
      // tar of it over the ssh link into `docker build -`.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* Command.start(
            Command.pipeTo(
              Command.make("tar", "-C", image.dir, "-c", "."),
              Command.make(
                "ssh",
                ...remote.ssh,
                shellJoin(["docker", ...args, "-"]),
              ),
            ),
          ).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.mapError((error) => spawnError(error)),
          );
          const [, errBytes, exitCode] = yield* Effect.all(
            [
              // The build log goes to stdout; drain it so the remote
              // process never blocks on a full pipe.
              Stream.runDrain(process.stdout),
              Stream.runCollect(process.stderr),
              process.exitCode,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.mapError((error) => fail(causeText(error))));
          const stderr = toText(errBytes);
          if (exitCode === 255) {
            return yield* linkLost(tail(stderr, 3));
          }
          if (exitCode !== 0) {
            return yield* refuse("docker build failed", {
              exitCode,
              stdout: "",
              stderr,
            });
          }
        }),
      );
    }
    const result = yield* capture([...args, image.dir]);
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
    options?: ExecOptions,
    user: "app" | "root" = "app",
  ): Stream.Stream<
    ExecEvent,
    DockerError | SandboxGoneError | LinkDroppedError
  > => {
    const dockerExec = [
      "exec",
      ...(options?.stdin === undefined ? [] : ["-i"]),
      "-u",
      user,
      "-w",
      "/home/app",
      container,
      ...argv,
    ];
    if (remote !== undefined) {
      return remote.stream(shellJoin(["docker", ...dockerExec]), options);
    }
    return commandEvents<DockerError>(
      executor,
      Command.make("docker", ...dockerExec),
      options,
      { spawn: spawnError, fail },
    );
  };

  const inspect = Effect.fn("DockerClient.inspect")(function* (
    container: string,
  ) {
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
      if (result.stderr.toLowerCase().includes("no such object")) {
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
      catch: (cause) => fail(causeText(cause)),
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

  const remove = Effect.fn("DockerClient.remove")(function* (
    container: string,
  ) {
    const result = yield* capture(["rm", "-f", container]);
    if (result.exitCode !== 0) {
      return yield* refuse("docker rm failed", result);
    }
  });

  return {
    serverArch,
    imageExists,
    pull,
    push,
    build,
    run,
    execText,
    execStream,
    inspect,
    listNames,
    remove,
  };
};
