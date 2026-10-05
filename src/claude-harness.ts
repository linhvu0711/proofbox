import { Either, Option, Schema } from "effect";
import { formatTime } from "./format-time.ts";
import type { Harness, HarnessStep } from "./harness.ts";
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

const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
});

const Init = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  model: Schema.String,
});

const ApiRetry = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_retry"),
  attempt: Schema.Number,
  error: Schema.String,
});

const User = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
});

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  content: Schema.Union(Schema.String, Schema.Array(Schema.Unknown)),
  isError: Schema.optional(Schema.Boolean).pipe(Schema.fromKey("is_error")),
});

const ActivityBlock = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    name: Schema.String,
    input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
);

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
  turn: ({ prompt, model, session }) => [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(Option.isSome(model) ? ["--model", model.value] : []),
    ...(Option.isSome(session) ? ["--resume", session.value] : []),
    "--",
    prompt,
  ],
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
  readSteps: (event) => {
    const decoded = Schema.decodeUnknownEither(
      Schema.parseJson(Schema.Union(Assistant, Init, ApiRetry, User)),
    )(event);
    if (Either.isLeft(decoded)) return [];
    const message = decoded.right;
    if (message.type === "system")
      return [
        {
          kind: "other",
          text:
            message.subtype === "init"
              ? `started: ${message.model}`
              : `API retry ${message.attempt}: ${message.error}`,
        },
      ];
    const steps: HarnessStep[] = [];
    for (const value of message.message.content) {
      if (message.type === "user") {
        const block = Schema.decodeUnknownEither(ToolResult)(value);
        if (Either.isLeft(block)) continue;
        const tool = block.right;
        const content =
          typeof tool.content === "string"
            ? tool.content
            : tool.content
                .flatMap((value) => {
                  const text = Schema.decodeUnknownEither(ActivityBlock)(value);
                  return Either.isRight(text) && text.right.type === "text"
                    ? [text.right.text]
                    : [];
                })
                .join("\n");
        steps.push({
          kind: "result",
          text: `${tool.isError === true ? "error" : "result"}: ${content}`,
        });
        continue;
      }
      const block = Schema.decodeUnknownEither(ActivityBlock)(value);
      if (Either.isLeft(block)) continue;
      if (block.right.type === "text") {
        steps.push({ kind: "said", text: block.right.text });
        continue;
      }
      const tool = block.right;
      const detail = ["command", "file_path", "pattern", "url", "description"]
        .map((key) => tool.input[key])
        .find((value): value is string => typeof value === "string");
      steps.push({
        kind: "tool",
        text: detail === undefined ? tool.name : `${tool.name}: ${detail}`,
      });
    }
    return steps;
  },
});
