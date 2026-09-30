import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import {
  Chunk,
  Config,
  Deferred,
  Effect,
  Redacted,
  Ref,
  type Scope,
  Stream,
} from "effect";
import {
  type BadLoginsFileError,
  type LoginExpiredError,
  type NotLoggedInError,
  ProviderError,
  ProviderUnavailableError,
  SandboxGoneError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import type { ProviderLogin } from "../provider.ts";
import { splitHostName } from "./regions.ts";

export interface NscExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// nsc still runs the SSH port-forward and the Snapshot expiry; everything
// else moved to the Compute API.
export type NscError =
  | BadLoginsFileError
  | LoginExpiredError
  | NotLoggedInError
  | ProviderError
  | ProviderUnavailableError
  | SandboxGoneError;

export interface NscClient {
  // `image` is `<repo>@sha256:<digest>` in the workspace registry.
  readonly ensureImageExpiry: (
    image: string,
    hours: number,
  ) => Effect.Effect<void, NscError>;
  // Scoped: the forwarded port lives until the scope closes. `gone` resolves
  // with the forward's failure if the process exits after its port is up.
  // `name` is the full host name, `<region>:<instanceId>`.
  readonly portForward: (
    name: string,
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
  login: ProviderLogin,
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
            "nsc is not installed; install the Namespace CLI, then try again",
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
    if (id !== undefined && text.includes("failed to start or was destroyed")) {
      return Effect.fail(new SandboxGoneError({ id: `ns:${id}` }));
    }
    return Effect.fail(
      fail(`nsc ${verb} failed: ${failedReason(result.stderr)}`),
    );
  };

  // nsc logs in with a bearer-token file; write the proofbox token to one
  // owner-only file per token, once per process.
  const written = new Set<string>();
  const tokenFile = Effect.gen(function* () {
    const inHand = yield* login;
    const token = Redacted.value(inHand.token);
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    const dir = (yield* keeperPaths({ provider: "ns", name: "__probe__" })).dir;
    const path = join(dir, `ns-token-${hash}.json`);
    if (!written.has(path)) {
      yield* Effect.tryPromise({
        try: () =>
          writeFile(path, `{"bearer_token":${JSON.stringify(token)}}\n`, {
            mode: 0o600,
          }),
        catch: (cause) => fail(describe(cause)),
      });
      written.add(path);
    }
    return path;
  });

  const nsc = (argv: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const bin = yield* nscBin.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      return Command.make(bin, ...argv).pipe(
        Command.env({ NSC_TOKEN_FILE: yield* tokenFile }),
      );
    });

  const capture = (
    argv: ReadonlyArray<string>,
  ): Effect.Effect<NscExecResult, NscError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* Command.start(yield* nsc(argv)).pipe(
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

  const portForward = (name: string, port: number) =>
    Effect.gen(function* () {
      const { region, instanceId } = splitHostName(name);
      const process = yield* Effect.acquireRelease(
        Command.start(
          yield* nsc([
            "--region",
            region,
            "instance",
            "port-forward",
            instanceId,
            "--target_port",
            String(port),
          ]),
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
          mapExit("port-forward", name, {
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
    ensureImageExpiry,
    portForward,
  };
};
