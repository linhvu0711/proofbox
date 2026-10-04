import { Either, Option, Schema } from "effect";
import type { Harness } from "../harness.ts";

const End = Schema.Struct({
  type: Schema.Literal("end"),
  session: Schema.String,
  message: Schema.String,
});

export const makeFakeHarness = (): Harness => ({
  name: "fake",
  install: () => "true",
  home: ".fake-harness",
  homeEntries: [],
  instructionsFile: "AGENTS.md",
  turn: ({ prompt, session }) => [
    "fake-harness",
    "turn",
    ...(Option.isSome(session) ? ["--resume", session.value] : []),
    prompt,
  ],
  readEnd: (output) => {
    try {
      const end = Schema.decodeUnknownEither(End)(
        JSON.parse(output.trimEnd().split("\n").at(-1) ?? ""),
      );
      return Either.isRight(end)
        ? {
            _tag: "Done",
            session: end.right.session,
            lastMessage: end.right.message,
          }
        : { _tag: "NoEnd" };
    } catch {
      return { _tag: "NoEnd" };
    }
  },
});
