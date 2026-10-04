import { Effect } from "effect";
import { BadMaxSizeError } from "../errors.ts";

export const MAX_SIZE_DEFAULT = 500_000_000;

const SIZE_PATTERN = /^([1-9][0-9]*)(MB|GB)$/;

export const parseMaxSize = Effect.fn("maxSize.parseMaxSize")(
  (value: string): Effect.Effect<number, BadMaxSizeError> => {
    const match = SIZE_PATTERN.exec(value);
    if (match === null) {
      return Effect.fail(new BadMaxSizeError({ value }));
    }
    const count = Number(match[1]);
    const unit = match[2] === "MB" ? 1_000_000 : 1_000_000_000;
    const bytes = count * unit;
    if (!Number.isSafeInteger(bytes)) {
      return Effect.fail(new BadMaxSizeError({ value }));
    }
    return Effect.succeed(bytes);
  },
);

export const formatMb = (bytes: number): string =>
  (bytes / 1_000_000).toFixed(1);
