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
  readSteps: () => [],
});
