import { writeFile } from "node:fs/promises";
import { Duration, Effect, Stream } from "effect";
import { PACE_SPAN, parseSpan, withDeadlinePush } from "./deadline.ts";
import {
  type BadSpanError,
  MissingCapabilityError,
  OutFileError,
  ProviderError,
} from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { type Os, Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

export const PIXEL_HELPER: Partial<Record<Os, string>> = {
  linux: "/opt/proofbox/pixel",
};

export const PACE_HUMAN = {
  glideMs: 400,
  letterMs: 80,
  typeMaxMs: 3000,
  settleMs: 700,
};

export const PACE_FAST = {
  glideMs: 0,
  letterMs: 12,
  typeMaxMs: 3000,
  settleMs: 0,
};

export interface Pace {
  readonly glideMs: number;
  readonly letterMs: number;
  readonly typeMaxMs: number;
  readonly settleMs: number;
}

export const resolvePace = (
  options: {
    readonly pace: "human" | "fast";
    readonly glide?: string | undefined;
    readonly letter?: string | undefined;
    readonly typeMax?: string | undefined;
    readonly settle?: string | undefined;
  },
  textLength = 0,
): Effect.Effect<Pace, BadSpanError> =>
  Effect.gen(function* () {
    const preset = options.pace === "human" ? PACE_HUMAN : PACE_FAST;
    const glideMs =
      options.glide === undefined
        ? preset.glideMs
        : Duration.toMillis(
            yield* parseSpan("glide", options.glide, PACE_SPAN),
          );
    const letterMs =
      options.letter === undefined
        ? preset.letterMs
        : Duration.toMillis(
            yield* parseSpan("letter", options.letter, PACE_SPAN),
          );
    const typeMaxMs =
      options.typeMax === undefined
        ? preset.typeMaxMs
        : Duration.toMillis(
            yield* parseSpan("type-max", options.typeMax, PACE_SPAN),
          );
    const settleMs =
      options.settle === undefined
        ? preset.settleMs
        : Duration.toMillis(
            yield* parseSpan("settle", options.settle, PACE_SPAN),
          );
    return {
      glideMs,
      letterMs:
        textLength > 0
          ? Math.min(letterMs, Math.floor(typeMaxMs / textLength))
          : letterMs,
      typeMaxMs,
      settleMs,
    };
  });

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const writeOut = (path: string, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => writeFile(path, bytes),
    catch: (cause) => new OutFileError({ path, reason: describe(cause) }),
  });

export const runPixel = (
  rawId: string,
  helperArgv: ReadonlyArray<string>,
  options: { readonly screenshot?: string | undefined } = {},
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
        outcome: "no action was taken",
      });
    }
    const info = yield* provider.get(id.name);
    const helper = PIXEL_HELPER[info.os];
    if (helper === undefined) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: "desktop",
        outcome: "no action was taken",
      });
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
    const bytes = Buffer.concat(collected.stdout);
    if (options.screenshot !== undefined) {
      yield* writeOut(options.screenshot, bytes);
    }
    return bytes;
  });
