import { Effect } from "effect";
import { readStdin } from "./stdin.ts";

export const readStdinText = Effect.fn("stdinToken.readStdinText")(() =>
  readStdin(),
);
