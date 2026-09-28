import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Effect, Exit, Stream } from "effect";
import { withDeadlinePush } from "./deadline.ts";
import { MissingCapabilityError, OutFileError } from "./errors.ts";
import {
  KeeperClient,
  type KeeperExecOptions,
} from "./keeper/keeper-client.ts";
import { type Os, Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const resolveHelper = (
  rawId: string,
  helpers: Partial<Record<Os, string>>,
  outcome: string,
) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    if (!provider.capabilities.has("desktop")) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "desktop",
        outcome,
      });
    }
    const info = yield* provider.get(id.name);
    const helper = helpers[info.os];
    if (helper === undefined) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "desktop",
        outcome,
      });
    }
    return { id, provider, info, helper };
  });

export const runHelper = (
  rawId: string,
  helpers: Partial<Record<Os, string>>,
  argv: ReadonlyArray<string>,
  options: {
    readonly outcome: string;
    readonly stdin?: KeeperExecOptions["stdin"];
  },
) =>
  Effect.gen(function* () {
    const { id, provider, info, helper } = yield* resolveHelper(
      rawId,
      helpers,
      options.outcome,
    );
    const keeper = yield* KeeperClient;
    const collected = yield* withDeadlinePush(
      provider,
      id.name,
      info,
    )(
      Effect.gen(function* () {
        const events = yield* keeper.exec(
          rawId,
          [helper, ...argv],
          options.stdin === undefined ? undefined : { stdin: options.stdin },
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
      provider: id.provider,
      code: collected.code,
      stdout: Buffer.concat(collected.stdout),
      stderr: Buffer.concat(collected.stderr).toString("utf8").trim(),
    };
  });

export const fetchHelper = (
  rawId: string,
  helpers: Partial<Record<Os, string>>,
  remote: string,
  dest: string,
  options: { readonly outcome: string },
) =>
  Effect.gen(function* () {
    const { id, provider, info, helper } = yield* resolveHelper(
      rawId,
      helpers,
      options.outcome,
    );
    const keeper = yield* KeeperClient;
    const collected = yield* withDeadlinePush(
      provider,
      id.name,
      info,
    )(
      Effect.gen(function* () {
        const events = yield* keeper.exec(rawId, [helper, "fetch", remote]);
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
                provider: id.provider,
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
      ),
    );
    return collected;
  });
