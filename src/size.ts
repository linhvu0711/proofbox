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
