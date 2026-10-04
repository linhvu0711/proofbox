import { Either, Option, Schema } from "effect";
import { formatTime } from "./format-time.ts";
import type { Harness } from "./harness.ts";
import { shellJoin } from "./shell.ts";

const Result = Schema.Struct({
  type: Schema.Literal("result"),
  isError: Schema.propertySignature(Schema.Boolean).pipe(
    Schema.fromKey("is_error"),
  ),
  sessionId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("session_id"),
  ),
  result: Schema.optional(Schema.String),
  apiErrorStatus: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.fromKey("api_error_status"),
  ),
});

const resetText = (message: string): Option.Option<string> => {
  const epoch = /\|(\d{10})(?!\d)/.exec(message);
  if (epoch !== null)
    return Option.some(formatTime(new Date(Number(epoch[1]) * 1000)));
  const words = /resets ([\s\S]*)/.exec(message)?.[1]?.trim();
  return words === undefined || words === ""
    ? Option.none()
    : Option.some(words);
};

export const makeClaudeHarness = (): Harness => ({
  name: "claude",
  install: (version) =>
    `set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://claude.ai/install.sh -o "$f"; bash "$f"${Option.isSome(version) ? ` ${shellJoin([version.value])}` : ""}`,
  home: ".claude",
  homeEntries: [".claude.json", ".local", ".cache"],
  instructionsFile: "CLAUDE.md",
  // Stand-in replaced by #193.
  turn: () => ["claude", "--version"],
  readEnd: (output) => {
    for (const line of output.trimEnd().split("\n").reverse()) {
      const decoded = Schema.decodeUnknownEither(Schema.parseJson(Result))(
        line,
      );
      if (Either.isLeft(decoded)) continue;
      const event = decoded.right;
      const message = event.result ?? "";
      if (!event.isError)
        return { _tag: "Done", session: event.sessionId, lastMessage: message };
      const kind =
        event.apiErrorStatus === 401
          ? "login"
          : event.apiErrorStatus === 429
            ? "usage-limit"
            : "other";
      return {
        _tag: "Failed",
        session: Option.some(event.sessionId),
        kind,
        message,
        resets: kind === "usage-limit" ? resetText(message) : Option.none(),
      };
    }
    return { _tag: "NoEnd" };
  },
  readActivity: () => Option.none(),
});
