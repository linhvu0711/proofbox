import { Either, Option, Schema } from "effect";
import type { Harness } from "./harness.ts";
import { shellJoin } from "./shell.ts";

const ThreadStarted = Schema.Struct({
  type: Schema.Literal("thread.started"),
  threadId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("thread_id"),
  ),
});

const AgentMessage = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("agent_message"),
    text: Schema.String,
  }),
});

const TurnCompleted = Schema.Struct({ type: Schema.Literal("turn.completed") });
const TurnFailed = Schema.Struct({
  type: Schema.Literal("turn.failed"),
  error: Schema.Struct({ message: Schema.String }),
});

const EndEvent = Schema.Union(
  ThreadStarted,
  AgentMessage,
  TurnCompleted,
  TurnFailed,
);
const decodeEndEvent = Schema.decodeUnknownEither(Schema.parseJson(EndEvent));

const CommandStarted = Schema.Struct({
  type: Schema.Literal("item.started"),
  item: Schema.Struct({
    type: Schema.Literal("command_execution"),
    command: Schema.String,
  }),
});

const CommandCompleted = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("command_execution"),
    aggregatedOutput: Schema.propertySignature(Schema.String).pipe(
      Schema.fromKey("aggregated_output"),
    ),
    exitCode: Schema.propertySignature(Schema.NullOr(Schema.Number)).pipe(
      Schema.fromKey("exit_code"),
    ),
  }),
});

const FileChange = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("file_change"),
    changes: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
});

const McpToolCall = Schema.Struct({
  type: Schema.Literal("item.started"),
  item: Schema.Struct({
    type: Schema.Literal("mcp_tool_call"),
    server: Schema.String,
    tool: Schema.String,
  }),
});

const WebSearch = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("web_search"),
    query: Schema.String,
  }),
});

const ErrorItem = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
});

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
});

const StepEvent = Schema.Union(
  ThreadStarted,
  AgentMessage,
  CommandStarted,
  CommandCompleted,
  FileChange,
  McpToolCall,
  WebSearch,
  ErrorItem,
  ErrorEvent,
);
const decodeStepEvent = Schema.decodeUnknownEither(Schema.parseJson(StepEvent));

export const makeCodexHarness = (): Harness => ({
  name: "codex",
  install: (version) =>
    `set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://chatgpt.com/codex/install.sh -o "$f"; env CODEX_NON_INTERACTIVE=1${Option.isSome(version) ? ` CODEX_RELEASE=${shellJoin([version.value])}` : ""} sh "$f" </dev/null`,
  home: ".codex",
  homeEntries: [".local"],
  instructionsFile: "AGENTS.md",
  turn: ({ prompt, model, session }) => [
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    ...(Option.isSome(session) ? ["resume"] : []),
    ...(Option.isSome(model) ? ["-m", model.value] : []),
    ...(Option.isSome(session) ? [session.value] : []),
    "--",
    prompt,
  ],
  readEnd: (output) => {
    const events = output.split("\n").flatMap((line) => {
      const decoded = decodeEndEvent(line);
      return Either.isRight(decoded) ? [decoded.right] : [];
    });
    const thread = events.find((event) => event.type === "thread.started");
    if (thread === undefined) return { _tag: "NoEnd" };
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === "turn.failed") {
        const message = event.error.message;
        const kind = /401|sign in again/i.test(message)
          ? "login"
          : /usage limit|out of credits|spend cap|quota exceeded/i.test(message)
            ? "usage-limit"
            : "other";
        const reset = /try again at (.+?)\./i.exec(message)?.[1];
        return {
          _tag: "Failed",
          session: Option.some(thread.threadId),
          kind,
          message,
          resets:
            kind === "usage-limit" && reset !== undefined
              ? Option.some(reset)
              : Option.none(),
        };
      }
      if (event?.type === "turn.completed") {
        const message = events
          .slice(0, i)
          .reverse()
          .find((preceding) => preceding.type === "item.completed");
        return {
          _tag: "Done",
          session: thread.threadId,
          lastMessage: message?.item.text ?? "",
        };
      }
    }
    return { _tag: "NoEnd" };
  },
  readSteps: (line) => {
    const decoded = decodeStepEvent(line);
    if (Either.isLeft(decoded)) return [];
    const event = decoded.right;
    switch (event.type) {
      case "thread.started":
        return [{ kind: "other", text: `started: ${event.threadId}` }];
      case "error":
        return [{ kind: "other", text: event.message }];
      case "item.started": {
        const item = event.item;
        return [
          {
            kind: "tool",
            text:
              item.type === "command_execution"
                ? `command_execution: ${item.command}`
                : `mcp_tool_call: ${item.server}/${item.tool}`,
          },
        ];
      }
      case "item.completed": {
        const item = event.item;
        switch (item.type) {
          case "agent_message":
            return [{ kind: "said", text: item.text }];
          case "command_execution":
            return [
              {
                kind: "result",
                text: `${item.exitCode === 0 ? "result" : "error"}: ${item.aggregatedOutput}`,
              },
            ];
          case "file_change":
            return [
              {
                kind: "tool",
                text: `file_change: ${item.changes.map((change) => change.path).join(", ")}`,
              },
            ];
          case "web_search":
            return [{ kind: "tool", text: `web_search: ${item.query}` }];
          case "error":
            return [{ kind: "other", text: `error: ${item.message}` }];
        }
      }
    }
  },
});
