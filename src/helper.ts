import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Effect, Exit, Stream } from "effect";
import { withDeadlinePush } from "./deadline.ts";
import { MissingCapabilityError } from "./errors.ts";
import {
  KeeperClient,
  type KeeperExecOptions,
} from "./keeper/keeper-client.ts";
import { type Os, Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

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
        const stream = yield* Effect.acquireRelease(
          Effect.sync(() => createWriteStream(dest)),
          (done) =>
            Effect.async<void>((resume) => {
              done.end(() => resume(Effect.void));
            }),
        );
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
                return Effect.die(writeError);
              }
              return Effect.async<void>((resume) => {
                if (stream.write(event.bytes)) {
                  resume(Effect.void);
                } else {
                  stream.once("drain", () => resume(Effect.void));
                }
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
        if (writeError !== undefined) {
          return yield* Effect.die(writeError);
        }
        return {
          provider: id.provider,
          code,
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
        };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) && exit.value.code === 0
            ? Effect.void
            : Effect.promise(() => unlink(dest).catch(() => {})),
        ),
      ),
    );
    return collected;
  });
