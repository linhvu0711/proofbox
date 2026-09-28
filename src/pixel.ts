import { writeFile } from "node:fs/promises";
import { Duration, Effect, Schema } from "effect";
import { PACE_SPAN, parseSpan } from "./deadline.ts";
import {
  type BadSpanError,
  OutFileError,
  OutsideScreenError,
  ProviderError,
} from "./errors.ts";
import { runHelper } from "./helper.ts";
import { type Os, Providers } from "./provider.ts";

export const PIXEL_HELPER: Partial<Record<Os, string>> = {
  linux: "/opt/proofbox/pixel",
};

export const ACTION_LOG_PATH = "/run/proofbox/action-log.jsonl";

export const ActionLogLine = Schema.Struct({
  t: Schema.Number,
  kind: Schema.Literal(
    "screenshot",
    "click",
    "type",
    "key",
    "scroll",
    "drag",
    "mark",
  ),
  x: Schema.Number.pipe(Schema.int()),
  y: Schema.Number.pipe(Schema.int()),
  toX: Schema.optional(Schema.Number.pipe(Schema.int())),
  toY: Schema.optional(Schema.Number.pipe(Schema.int())),
  step: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
});

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
  options: {
    readonly screenshot?: string | undefined;
    readonly points?: ReadonlyArray<readonly [number, number]>;
  } = {},
) =>
  Effect.gen(function* () {
    const collected = yield* runHelper(rawId, PIXEL_HELPER, helperArgv, {
      outcome: "no action was taken",
    });
    if (collected.code === 3) {
      const [width, height] = collected.stdout
        .toString("utf8")
        .trim()
        .split(" ")
        .map(Number);
      const points = options.points ?? [];
      const [x, y] = points.find(
        ([px, py]) =>
          width !== undefined &&
          height !== undefined &&
          (px < 0 || py < 0 || px >= width || py >= height),
      ) ??
        points[0] ?? [0, 0];
      return yield* new OutsideScreenError({
        x,
        y,
        width: width ?? 0,
        height: height ?? 0,
      });
    }
    if (collected.code !== 0) {
      return yield* new ProviderError({
        provider: collected.provider,
        reason: `input helper failed: ${collected.stderr}`,
      });
    }
    if (options.screenshot !== undefined) {
      yield* writeOut(options.screenshot, collected.stdout);
    }
    return collected.stdout;
  });
