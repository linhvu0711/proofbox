import { writeFile } from "node:fs/promises";
import { Effect, Stream } from "effect";
import { withDeadlinePush } from "./deadline.ts";
import { OutFileError, ProviderError } from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { type Os, Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

export const PIXEL_HELPER: Partial<Record<Os, string>> = {
  linux: "/opt/proofbox/pixel",
};

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const writeOut = (path: string, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => writeFile(path, bytes),
    catch: (cause) => new OutFileError({ path, reason: describe(cause) }),
  });

export const runPixel = (rawId: string, helperArgv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    const info = yield* provider.get(id.name);
    const helper = PIXEL_HELPER[info.os];
    if (helper === undefined) {
      return yield* Effect.die(new Error(`no Pixel helper for ${info.os}`));
    }
    const keeper = yield* KeeperClient;
    const collected = yield* withDeadlinePush(
      provider,
      id.name,
      info,
    )(
      Effect.gen(function* () {
        const events = yield* keeper.exec(rawId, [helper, ...helperArgv]);
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
                  return { ...acc, stdout: [...acc.stdout, event.bytes] };
                case "Stderr":
                  return { ...acc, stderr: [...acc.stderr, event.bytes] };
                case "Exit":
                  return { ...acc, code: event.code };
              }
            },
          ),
        );
      }),
    );
    if (collected.code !== 0) {
      return yield* new ProviderError({
        provider: id.provider,
        reason: `input helper failed: ${Buffer.concat(collected.stderr)
          .toString("utf8")
          .trim()}`,
      });
    }
    return Buffer.concat(collected.stdout);
  });
