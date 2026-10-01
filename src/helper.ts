import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Config, Duration, Effect, Exit, Stream } from "effect";
import { CliOutput } from "./cli-output.ts";
import { parseSpan } from "./deadline.ts";
import {
  type AnswerTimeoutError,
  MissingCapabilityError,
  NoAnswerError,
  OutFileError,
  ProviderError,
} from "./errors.ts";
import { formatWait } from "./format-time.ts";
import {
  type AnswerLimit,
  KeeperClient,
  type KeeperExecOptions,
} from "./keeper/keeper-client.ts";
import { keeperPaths } from "./keeper/paths.ts";
import { type Feature, lacksFeature, type Os, Providers } from "./provider.ts";
import {
  fileStem,
  type ResolvedSandboxId,
  resolveSandboxId,
} from "./sandbox-id.ts";

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

// A helper in the Sandbox, the feature it serves, and its path per OS.
export interface HelperTable {
  readonly feature: Feature;
  readonly paths: Partial<Record<Os, string>>;
}

const resolveHelper = Effect.fn("helper.resolveHelper")(function* (
  rawId: string,
  table: HelperTable,
  outcome: string,
) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const provider = id.provider;
  const hasDesktop = Object.values(provider.offers).some((offer) =>
    offer.features.has("desktop"),
  );
  if (!hasDesktop) {
    return yield* new MissingCapabilityError({
      provider: provider.name,
      capability: "desktop",
      outcome,
    });
  }
  // The warm Keeper answers from what it read at connect, and pushes the
  // Deadline in the helper's own call (ADR 0015).
  const info = yield* (yield* KeeperClient).info(rawId);
  const features = provider.offers[info.os]?.features;
  if (features === undefined || !features.has("desktop")) {
    return yield* lacksFeature(provider, info.os, "desktop", outcome);
  }
  if (!features.has(table.feature)) {
    return yield* lacksFeature(provider, info.os, table.feature, outcome);
  }
  const helper = table.paths[info.os];
  if (helper === undefined) {
    return yield* lacksFeature(provider, info.os, table.feature, outcome);
  }
  return { provider, info, helper, id };
});

// How long a helper call waits for its answer, and what it does when none
// comes (ADR 0019). A Read only reads, so it tries once more. An Act
// changes something, so it never tries again; `extra` is its own pace or
// Recording time on top of the wait. A Download waits for new bytes, not
// for the whole file, and tries once more from the start.
export type HelperLimit =
  | { readonly _tag: "Read"; readonly name: string }
  | {
      readonly _tag: "Act";
      readonly name: string;
      readonly extra: Duration.Duration;
    }
  | { readonly _tag: "Download"; readonly name: string };

// A Sandbox that never ends its answer gets this long; tests make it short.
const answerWaitText = Config.string("PROOFBOX_ANSWER_WAIT").pipe(
  Config.withDefault("120s"),
);

// Runs `attempt` under the limit, tries a Read or a Download once more,
// and turns a last AnswerTimeoutError into the Caller's NoAnswerError.
const withHelperLimit = Effect.fn("helper.withHelperLimit")(function* <A, E, R>(
  rawId: string,
  id: ResolvedSandboxId,
  limit: HelperLimit,
  attempt: (answer: AnswerLimit) => Effect.Effect<A, E | AnswerTimeoutError, R>,
) {
  const wait = yield* parseSpan(
    "PROOFBOX_ANSWER_WAIT",
    yield* answerWaitText.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({
            provider: id.provider.name,
            reason: error.message,
          }),
      ),
    ),
  );
  const paths = yield* keeperPaths({
    provider: id.prefix,
    name: fileStem(id),
  });
  const noAnswer = (kind: NoAnswerError["kind"], after: Duration.Duration) =>
    new NoAnswerError({
      id: rawId,
      call: limit.name,
      wait: formatWait(after),
      kind,
      log: paths.log,
    });
  switch (limit._tag) {
    case "Act": {
      const whole = Duration.sum(wait, limit.extra);
      return yield* attempt({ whole }).pipe(
        Effect.catchTag("AnswerTimeoutError", () =>
          Effect.fail(noAnswer("act", whole)),
        ),
      );
    }
    case "Read":
    case "Download": {
      const answer: AnswerLimit =
        limit._tag === "Read" ? { whole: wait } : { idle: wait };
      const output = yield* CliOutput;
      const again =
        limit._tag === "Read"
          ? `proofbox: the ${limit.name} did not answer in ${formatWait(wait)}; trying once more\n`
          : `proofbox: the ${limit.name} sent no bytes for ${formatWait(wait)}; trying once more\n`;
      return yield* attempt(answer).pipe(
        Effect.catchTag("AnswerTimeoutError", () =>
          output.err(again).pipe(Effect.zipRight(attempt(answer))),
        ),
        Effect.catchTag("AnswerTimeoutError", () =>
          Effect.fail(
            noAnswer(limit._tag === "Read" ? "read" : "download", wait),
          ),
        ),
      );
    }
  }
});

export const runHelper = Effect.fn("helper.runHelper")(function* (
  rawId: string,
  table: HelperTable,
  argv: ReadonlyArray<string>,
  options: {
    readonly outcome: string;
    readonly stdin?: KeeperExecOptions["stdin"];
    readonly limit: HelperLimit;
  },
) {
  const resolved = yield* resolveHelper(rawId, table, options.outcome);
  const { provider, info, helper } = resolved;
  const keeper = yield* KeeperClient;
  const collected = yield* withHelperLimit(
    rawId,
    resolved.id,
    options.limit,
    (limit) =>
      Effect.gen(function* () {
        const events = yield* keeper.exec(
          rawId,
          [helper, ...argv],
          options.stdin === undefined
            ? { limit }
            : { stdin: options.stdin, limit },
        );
        return yield* events.pipe(
          Stream.runFold(
            {
              stdout: [] as Uint8Array[],
              stderr: [] as Uint8Array[],
              code: undefined as number | undefined,
            },
            (acc, event) => {
              switch (event._tag) {
                case "Stdout":
                  acc.stdout.push(event.bytes);
                  return acc;
                case "Stderr":
                  acc.stderr.push(event.bytes);
                  return acc;
                case "Exit":
                  return { ...acc, code: event.code };
              }
            },
          ),
        );
      }),
  );
  return {
    provider: provider.name,
    os: info.os,
    code: collected.code,
    stdout: Buffer.concat(collected.stdout),
    stderr: Buffer.concat(collected.stderr).toString("utf8").trim(),
  };
});

export const fetchHelper = Effect.fn("helper.fetchHelper")(function* (
  rawId: string,
  table: HelperTable,
  remote: string,
  dest: string,
  // `name`: what the Caller reads in a stall message, as "Proof video".
  options: { readonly outcome: string; readonly name: string },
) {
  const resolved = yield* resolveHelper(rawId, table, options.outcome);
  const { provider, helper } = resolved;
  const keeper = yield* KeeperClient;
  // One try writes `<dest>.part` from the start and removes it unless the
  // download ended whole, so a second try never sees the first one's bytes.
  const attempt = (limit: AnswerLimit) =>
    Effect.gen(function* () {
      const events = yield* keeper.exec(rawId, [helper, "fetch", remote], {
        limit,
      });
      const part = `${dest}.part`;
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => createWriteStream(part)),
        (stream) =>
          Effect.gen(function* () {
            let writeError: Error | undefined;
            stream.on("error", (error) => {
              writeError = error;
            });
            const stderr: Uint8Array[] = [];
            let code: number | undefined;
            yield* events.pipe(
              Stream.runForEach((event) => {
                if (event._tag === "Stdout") {
                  if (writeError !== undefined) {
                    return Effect.fail(
                      new OutFileError({
                        path: dest,
                        reason: describe(writeError),
                      }),
                    );
                  }
                  return Effect.async<void, OutFileError>((resume) => {
                    stream.write(event.bytes, (error) => {
                      resume(
                        error === undefined || error === null
                          ? Effect.void
                          : Effect.fail(
                              new OutFileError({
                                path: dest,
                                reason: describe(error),
                              }),
                            ),
                      );
                    });
                  });
                }
                if (event._tag === "Stderr") {
                  stderr.push(event.bytes);
                } else {
                  code = event.code;
                }
                return Effect.void;
              }),
            );
            yield* Effect.async<void>((resume) => {
              if (writeError !== undefined) {
                resume(Effect.void);
                return;
              }
              stream.once("error", () => resume(Effect.void));
              stream.end(() => resume(Effect.void));
            });
            if (writeError !== undefined) {
              return yield* new OutFileError({
                path: dest,
                reason: describe(writeError),
              });
            }
            if (code === 0) {
              yield* Effect.tryPromise({
                try: () => rename(part, dest),
                catch: (cause) =>
                  new OutFileError({
                    path: dest,
                    reason: describe(cause),
                  }),
              });
            }
            return {
              provider: provider.name,
              code,
              stderr: Buffer.concat(stderr).toString("utf8").trim(),
            };
          }),
        (stream) => Effect.sync(() => stream.destroy()),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && exit.value.code === 0
          ? Effect.void
          : Effect.promise(() => unlink(`${dest}.part`).catch(() => {})),
      ),
    );
  return yield* withHelperLimit(
    rawId,
    resolved.id,
    { _tag: "Download", name: options.name },
    attempt,
  );
});
