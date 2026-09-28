import { Effect, Schema } from "effect";
import { BadSizeError } from "./errors.ts";

export const Size = Schema.Struct({
  cpu: Schema.Number.pipe(Schema.int(), Schema.positive()),
  ramGb: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
export type Size = typeof Size.Type;

export const formatSize = (size: Size): string => `${size.cpu}x${size.ramGb}`;

const SIZE_PATTERN = /^([1-9][0-9]*)x([1-9][0-9]*)$/;

export const parseSize = (value: string): Effect.Effect<Size, BadSizeError> => {
  const match = SIZE_PATTERN.exec(value);
  if (match === null) {
    return Effect.fail(new BadSizeError({ value }));
  }
  return Effect.succeed({
    cpu: Number(match[1]),
    ramGb: Number(match[2]),
  });
};

export const OUT_OF_MEMORY_EXIT = 122;

export const outOfMemoryMessage = (
  size: Size | undefined,
  offered: "any" | ReadonlyArray<Size>,
): string => {
  if (size === undefined) {
    return "Sandbox ran out of memory (no size limit). The host has no free memory left.";
  }
  const current = formatSize(size);
  if (offered === "any") {
    const next = formatSize({ cpu: size.cpu * 2, ramGb: size.ramGb * 2 });
    return `Sandbox ran out of memory (${current}). Try --size ${next}.`;
  }
  const index = offered.findIndex(
    (listed) => listed.cpu === size.cpu && listed.ramGb === size.ramGb,
  );
  if (index >= 0 && index < offered.length - 1) {
    const next = offered[index + 1] as Size;
    return `Sandbox ran out of memory (${current}). Try --size ${formatSize(next)}.`;
  }
  return `Sandbox ran out of memory (${current}). ${current} is the largest size.`;
};
