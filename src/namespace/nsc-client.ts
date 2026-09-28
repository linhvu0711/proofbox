import { Command, CommandExecutor } from "@effect/platform";
import {
  Chunk,
  Config,
  Deferred,
  Effect,
  Fiber,
  Option,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { parseSpan } from "../deadline.ts";
import {
  ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
} from "../errors.ts";

export const NscInstance = Schema.Struct({
  clusterId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("cluster_id"),
  ),
});
export type NscInstance = typeof NscInstance.Type;

const NscCreateResult = Schema.Struct({
  instanceId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("instance_id"),
  ),
});

export interface NscExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NscError =
  | ProviderError
  | ProviderUnavailableError
  | SandboxGoneError;

export interface NscClient {
  readonly checkLogin: Effect.Effect<void, NscError>;
  readonly create: (req: {
    readonly machineType: string;
    readonly durationSeconds: number;
    readonly sshKeyFile: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly cidfile: string;
  }) => Effect.Effect<string, NscError | ProviderLimitError>;
  readonly destroy: (id: string) => Effect.Effect<void, NscError>;
  readonly ensureImageExpiry: (
    image: string,
    hours: number,
  ) => Effect.Effect<void, NscError>;
  readonly extend: (
    id: string,
    seconds: number,
  ) => Effect.Effect<void, NscError>;
  readonly list: (
    labels: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<NscInstance>, NscError>;
  // Scoped: the forwarded port lives until the scope closes. `gone` resolves
  // with the forward's failure if the process exits after its port is up.
  readonly portForward: (
    id: string,
    port: number,
  ) => Effect.Effect<
    { readonly port: number; readonly gone: Effect.Effect<never, NscError> },
    NscError,
    Scope.Scope
  >;
}

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const toText = (chunks: Chunk.Chunk<Uint8Array>) =>
  Buffer.concat(Chunk.toReadonlyArray(chunks).map((bytes) => bytes)).toString(
    "utf8",
  );

const nscBin = Config.string("PROOFBOX_NSC").pipe(Config.withDefault("nsc"));

export const makeNscClient = (
  executor: CommandExecutor.CommandExecutor,
): NscClient => {
  const fail = (reason: string) =>
    new ProviderError({ provider: "namespace", reason });

  // A missing `nsc` binary is a spawn ENOENT (SystemError "NotFound").
  const spawnError = (error: {
    readonly _tag: string;
    readonly reason?: unknown;
    readonly message: string;
  }) =>
    error._tag === "SystemError" && error.reason === "NotFound"
      ? new ProviderUnavailableError({
          provider: "namespace",
          reason:
            "nsc is not installed; install the Namespace CLI, then run: nsc login",
        })
      : fail(error.message);

  // nsc reports a failed call as `Failed: <reason>` on stderr; the reason may
  // wrap onto the next lines, so join stderr into one line first.
  const failedReason = (text: string): string => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    const at = oneLine.lastIndexOf("Failed:");
    if (at !== -1) {
      const after = oneLine.slice(at + "Failed:".length).trim();
      if (after !== "") {
        return after;
      }
    }
    return oneLine;
  };

  const mapExit = (
    verb: string,
    id: string | undefined,
    result: NscExecResult,
  ): Effect.Effect<never, NscError> => {
    // nsc wraps long lines at a fixed column, so match against the text with
    // newlines collapsed or a phrase like "was\ndestroyed" is missed.
    const text = `${result.stderr}\n${result.stdout}`.replace(/\s+/g, " ");
    if (text.includes("not logged in")) {
      return Effect.fail(
        new ProviderUnavailableError({
          provider: "namespace",
          reason: "Namespace: not logged in; run: nsc login",
        }),
      );
    }
    if (id !== undefined && text.includes("failed to start or was destroyed")) {
      return Effect.fail(new SandboxGoneError({ id: `ns:${id}` }));
    }
    return Effect.fail(
      fail(`nsc ${verb} failed: ${failedReason(result.stderr)}`),
    );
  };

  const capture = (
    argv: ReadonlyArray<string>,
  ): Effect.Effect<NscExecResult, NscError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const bin = yield* nscBin.pipe(
          Effect.mapError((error) => fail(error.message)),
        );
        const process = yield* Command.start(Command.make(bin, ...argv)).pipe(
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
        } satisfies NscExecResult;
      }),
    );

  const checkLogin = Effect.gen(function* () {
    const result = yield* capture(["auth", "check-login"]);
    if (result.exitCode !== 0) {
      return yield* mapExit("auth check-login", undefined, result);
    }
  });

  const createTimeout = Config.string("PROOFBOX_NS_CREATE_TIMEOUT").pipe(
    Config.withDefault("60s"),
  );

  // nsc sometimes hangs mid-create; bound the wait, then interrupt it and
  // clean up whatever it half-made.
  const create = (req: {
    readonly machineType: string;
    readonly durationSeconds: number;
    readonly sshKeyFile: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly cidfile: string;
  }) =>
    Effect.gen(function* () {
      const spanText = yield* createTimeout.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const span = yield* parseSpan(
        "PROOFBOX_NS_CREATE_TIMEOUT",
        spanText,
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const bin = yield* nscBin.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const { timedOut, result } = yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* Command.start(
            Command.make(
              bin,
              "create",
              "--bare",
              "--machine_type",
              req.machineType,
              "--duration",
              `${req.durationSeconds}s`,
              "--ssh_key",
              req.sshKeyFile,
              ...Object.entries(req.labels).flatMap(([key, value]) => [
                "--label",
                `${key}=${value}`,
              ]),
              "--cidfile",
              req.cidfile,
              "-o",
              "json",
            ),
          ).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.mapError((error) => spawnError(error)),
          );
          const outBytes = yield* Stream.runCollect(process.stdout).pipe(
            Effect.forkScoped,
          );
          const errBytes = yield* Stream.runCollect(process.stderr).pipe(
            Effect.forkScoped,
          );
          const finished = process.exitCode.pipe(Effect.orElseSucceed(() => 1));
          const timedOut = yield* Effect.raceFirst(
            finished.pipe(Effect.as(false)),
            Effect.sleep(span).pipe(Effect.as(true)),
          );
          if (timedOut) {
            yield* Effect.orElseSucceed(
              process.kill("SIGINT"),
              () => undefined,
            );
            // An nsc that ignores SIGINT must not hang the create: give it
            // a beat, then kill it outright.
            const exited = yield* finished.pipe(
              Effect.timeoutOption("5 seconds"),
            );
            if (Option.isNone(exited)) {
              yield* Effect.orElseSucceed(
                process.kill("SIGKILL"),
                () => undefined,
              );
            }
          }
          const [out, err, exitCode] = yield* Effect.all(
            [Fiber.join(outBytes), Fiber.join(errBytes), finished],
            { concurrency: "unbounded" },
          ).pipe(Effect.mapError((error) => fail(describe(error))));
          return {
            timedOut,
            result: {
              exitCode,
              stdout: toText(out),
              stderr: toText(err),
            } satisfies NscExecResult,
          };
        }),
      );
      // A refused create names the capacity it wanted; pull the clause that
      // ends at the first `)` so the size is included.
      const capacity = /ran out of capacity:[^)]*\)/.exec(
        result.stderr.replace(/\s+/g, " "),
      );
      if (capacity !== null) {
        return yield* new ProviderLimitError({
          provider: "namespace",
          limit: capacity[0],
        });
      }
      if (timedOut) {
        return yield* new ProviderUnavailableError({
          provider: "namespace",
          reason: `Namespace did not make the host in ${spanText.replace(/(\d)([a-z])/g, "$1 $2")}; deleted any half-made host. Try again`,
        });
      }
      if (result.exitCode !== 0) {
        return yield* mapExit("create", undefined, result);
      }
      const parsed = yield* Schema.decodeUnknown(
        Schema.parseJson(NscCreateResult),
      )(result.stdout).pipe(
        Effect.mapError((error) =>
          fail(`nsc create failed: ${describe(error)}`),
        ),
      );
      return parsed.instanceId;
    });

  const destroy = (id: string) =>
    Effect.gen(function* () {
      const result = yield* capture(["destroy", id, "--force"]);
      if (result.exitCode !== 0) {
        return yield* mapExit("destroy", id, result);
      }
    });

  const ensureImageExpiry = (image: string, hours: number) =>
    Effect.gen(function* () {
      const result = yield* capture([
        "registry",
        "update-image-expiration",
        image,
        "--ensure-minimum",
        `${hours}h`,
      ]);
      if (result.exitCode !== 0) {
        return yield* mapExit(
          "registry update-image-expiration",
          undefined,
          result,
        );
      }
    });

  const extend = (id: string, seconds: number) =>
    Effect.gen(function* () {
      const result = yield* capture([
        "extend",
        id,
        "--ensure_minimum",
        `${seconds}s`,
      ]);
      if (result.exitCode !== 0) {
        return yield* mapExit("extend", id, result);
      }
    });

  const list = (labels: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const result = yield* capture([
        "list",
        "-o",
        "json",
        ...Object.entries(labels).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
      ]);
      if (result.exitCode !== 0) {
        return yield* mapExit("list", undefined, result);
      }
      const parsed = yield* Schema.decodeUnknown(
        Schema.parseJson(Schema.NullOr(Schema.Array(NscInstance))),
      )(result.stdout).pipe(
        Effect.mapError((error) => fail(`nsc list failed: ${describe(error)}`)),
      );
      return parsed ?? [];
    });

  const portForward = (id: string, port: number) =>
    Effect.gen(function* () {
      const bin = yield* nscBin.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const process = yield* Effect.acquireRelease(
        Command.start(
          Command.make(
            bin,
            "instance",
            "port-forward",
            id,
            "--target_port",
            String(port),
          ),
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.mapError((error) => spawnError(error)),
        ),
        (process) =>
          Effect.orElseSucceed(process.kill("SIGKILL"), () => undefined),
      );
      const stderr = yield* Ref.make("");
      const stderrDone = yield* Deferred.make<void>();
      const listening = yield* Deferred.make<number>();
      // Keep both stdout and stderr open for the life of the process:
      // ending a read early lets the next nsc log line hit a closed pipe
      // and kills the forward.
      yield* Stream.runForEach(process.stderr, (bytes) =>
        Ref.update(
          stderr,
          (text) => text + Buffer.from(bytes).toString("utf8"),
        ),
      ).pipe(
        Effect.ensuring(Deferred.complete(stderrDone, Effect.void)),
        Effect.forkScoped,
      );
      yield* process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(line);
          return match === null
            ? Effect.void
            : Deferred.complete(listening, Effect.succeed(Number(match[1])));
        }),
        Effect.forkScoped,
      );
      const gone = process.exitCode.pipe(
        Effect.orElseSucceed(() => 1),
        // The stderr drain can lag the exit by a beat; give it a moment so a
        // "was destroyed" line still maps to SandboxGoneError.
        Effect.zipRight(
          Deferred.await(stderrDone).pipe(
            Effect.timeout("2 seconds"),
            Effect.ignore,
          ),
        ),
        Effect.zipRight(Ref.get(stderr)),
        Effect.flatMap((text) =>
          mapExit("port-forward", id, {
            exitCode: 1,
            stdout: "",
            stderr: text,
          }),
        ),
      );
      const bound = yield* Effect.raceFirst(Deferred.await(listening), gone);
      return { port: bound, gone };
    });

  return {
    checkLogin,
    create,
    destroy,
    ensureImageExpiry,
    extend,
    list,
    portForward,
  };
};
