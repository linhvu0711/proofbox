import { Command, CommandExecutor } from "@effect/platform";
import { Effect, Option, Stream } from "effect";
import {
  captureCommand,
  collectEvents,
  commandEvents,
} from "../command-events.ts";
import {
  causeText,
  type LinkDroppedError,
  ProviderError,
  ProviderUnavailableError,
  type SandboxGoneError,
} from "../errors.ts";
import type { ExecEvent, ExecOptions } from "../provider.ts";

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerInspection {
  readonly labels: unknown;
  readonly running: boolean;
}

export type DockerError = ProviderError | ProviderUnavailableError;

// Where docker commands run: this machine, or a host over a link. `E` is
// what the host itself can fail a text call with.
export interface DockerHost<E = never> {
  // The Provider its errors name.
  readonly provider: string;
  readonly run: (
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<DockerExecResult, DockerError | E>;
  readonly stream: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Stream.Stream<
    ExecEvent,
    DockerError | SandboxGoneError | LinkDroppedError
  >;
  // What a call fails with when Docker does not answer.
  readonly unavailable: ProviderUnavailableError;
}

export interface DockerClient<E = never> {
  readonly serverArch: Effect.Effect<string, DockerError | E>;
  readonly imageExists: (
    tag: string,
  ) => Effect.Effect<boolean, DockerError | E>;
  readonly pull: (tag: string) => Effect.Effect<boolean, DockerError | E>;
  readonly push: (tag: string) => Effect.Effect<void, DockerError | E>;
  readonly build: (image: {
    readonly dir: string;
    readonly tag: string;
    readonly buildArgs: Readonly<Record<string, string>>;
  }) => Effect.Effect<void, DockerError | E>;
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<DockerExecResult, DockerError | E>;
  readonly execText: (
    container: string,
    user: string,
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<DockerExecResult, DockerError | E>;
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
  ) => Effect.Effect<Option.Option<DockerInspection>, DockerError | E>;
  readonly listNames: Effect.Effect<ReadonlyArray<string>, DockerError | E>;
  readonly remove: (container: string) => Effect.Effect<void, DockerError | E>;
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

// The `docker` on this machine.
export const localDockerHost = (
  executor: CommandExecutor.CommandExecutor,
): DockerHost => {
  const unavailable = new ProviderUnavailableError({
    provider: "docker",
    reason: "Docker is not running; start Docker and try again",
  });
  const fail = (reason: string) =>
    new ProviderError({ provider: "docker", reason });
  // A missing `docker` binary is a spawn ENOENT (SystemError "NotFound"); a
  // stopped daemon answers every call with DOCKER_DOWN.
  const spawnError = (error: {
    readonly _tag: string;
    readonly reason?: unknown;
    readonly message: string;
  }) =>
    error._tag === "SystemError" && error.reason === "NotFound"
      ? unavailable
      : fail(error.message);
  return {
    provider: "docker",
    run: (argv) =>
      captureCommand(Command.make("docker", ...argv)).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.mapError((error) => spawnError(error)),
      ),
    stream: (argv, options) =>
      commandEvents<DockerError>(
        executor,
        Command.make("docker", ...argv),
        options,
        { spawn: spawnError, fail },
      ),
    unavailable,
  };
};

export const makeDockerClient = <E = never>(
  executor: CommandExecutor.CommandExecutor,
  host: DockerHost<E>,
): DockerClient<E> => {
  const unavailable = () => host.unavailable;
  const fail = (reason: string) =>
    new ProviderError({ provider: host.provider, reason });

  const refuse = (what: string, result: DockerExecResult) =>
    isDown(result)
      ? Effect.fail(unavailable())
      : Effect.fail(
          fail(`${what}: ${tail(result.stderr + result.stdout, 20)}`),
        );

  const capture = host.run;

  // The build folder as a tar on this machine. A tar that fails still ends
  // its stdout cleanly, so its exit code is checked here.
  const packed = (dir: string): Stream.Stream<Uint8Array, ProviderError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const process = yield* Command.start(
          Command.make("tar", "-C", dir, "-c", "."),
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.mapError((error) => fail(error.message)),
        );
        const exited = Stream.fromEffect(process.exitCode).pipe(
          Stream.mapError((error) => fail(causeText(error))),
          Stream.flatMap((code) =>
            code === 0
              ? Stream.empty
              : Stream.fail(
                  fail(
                    `could not pack the build folder ${dir}: tar exited ${code}`,
                  ),
                ),
          ),
        );
        return Stream.concat(
          process.stdout.pipe(
            Stream.mapError((error) => fail(causeText(error))),
          ),
          exited,
        );
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
    const result = yield* collectEvents(
      host.stream([...args, "-"], { stdin: packed(image.dir) }),
    ).pipe(
      Effect.catchTag("LinkDroppedError", (error) =>
        Effect.fail(
          new ProviderUnavailableError({
            provider: host.provider,
            reason: error.reason,
          }),
        ),
      ),
      Effect.catchTag("SandboxGoneError", (error) =>
        Effect.fail(fail(error.message)),
      ),
    );
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
    return host.stream(dockerExec, options);
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
