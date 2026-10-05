import { Option } from "effect";
import { expect, it } from "vitest";
import { makeCodexHarness } from "../src/codex-harness.ts";

const session = "01a10a23-ae48-7920-af12-67d3a28ea163";
const thread = `{"type":"thread.started","thread_id":"${session}"}`;
const done = [
  thread,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"made hello.txt"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");

it("a Codex Turn runs headless with approvals and its sandbox off", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const argv = harness.turn({
    prompt: "make hello.txt",
    model: Option.none(),
    session: Option.none(),
  });
  // Then
  expect(argv).toEqual([
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--",
    "make hello.txt",
  ]);
});

it("a Codex Turn resumes its session with the model it is given", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const argv = harness.turn({
    prompt: "recall",
    model: Option.some("gpt-5"),
    session: Option.some("01a10a23-ae48-7920-af12-67d3a28ea163"),
  });
  // Then
  expect(argv).toEqual([
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "resume",
    "-m",
    "gpt-5",
    "01a10a23-ae48-7920-af12-67d3a28ea163",
    "--",
    "recall",
  ]);
});

it("Codex installs the newest version or the one it is given", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const commands = [
    harness.install(Option.none()),
    harness.install(Option.some("0.159.0")),
  ];
  // Then
  expect(commands).toEqual([
    `set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://chatgpt.com/codex/install.sh -o "$f"; env CODEX_NON_INTERACTIVE=1 sh "$f" </dev/null`,
    `set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://chatgpt.com/codex/install.sh -o "$f"; env CODEX_NON_INTERACTIVE=1 CODEX_RELEASE='0.159.0' sh "$f" </dev/null`,
  ]);
});

it("a Codex Turn is done when turn.completed ends it", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const end = harness.readEnd(done);
  // Then
  expect(end).toEqual({ _tag: "Done", session, lastMessage: "made hello.txt" });
});

it("a refused Codex login reads as a login failure", () => {
  // Given
  const harness = makeCodexHarness();
  const message =
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
  const output = [
    thread,
    JSON.stringify({
      type: "error",
      message: `Reconnecting... 2/5 (${message})`,
    }),
    JSON.stringify({ type: "turn.failed", error: { message } }),
  ].join("\n");
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({
    _tag: "Failed",
    session: Option.some(session),
    kind: "login",
    message,
    resets: Option.none(),
  });
});

it("a refused ChatGPT workspace login reads as a login failure", () => {
  // Given
  const harness = makeCodexHarness();
  const message = "workspace routing discovery unauthorized (401)";
  const output = `${thread}\n${JSON.stringify({ type: "turn.failed", error: { message } })}`;
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({
    _tag: "Failed",
    session: Option.some(session),
    kind: "login",
    message,
    resets: Option.none(),
  });
});

it("a Codex usage limit reads with its reset time", () => {
  // Given
  const harness = makeCodexHarness();
  const message = "You’ve hit your usage limit. Try again at 3:07 PM.";
  const output = `${thread}\n${JSON.stringify({ type: "turn.failed", error: { message } })}`;
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({
    _tag: "Failed",
    session: Option.some(session),
    kind: "usage-limit",
    message,
    resets: Option.some("3:07 PM"),
  });
});

it("a Codex usage limit on another day reads with its date", () => {
  // Given
  const harness = makeCodexHarness();
  const message =
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 7th, 2026 3:07 PM.";
  const output = `${thread}\n${JSON.stringify({ type: "turn.failed", error: { message } })}`;
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({
    _tag: "Failed",
    session: Option.some(session),
    kind: "usage-limit",
    message,
    resets: Option.some("Oct 7th, 2026 3:07 PM"),
  });
});

it("a failed Codex Turn of another kind reads as a crash", () => {
  // Given
  const harness = makeCodexHarness();
  const message =
    "exceeded retry limit, last status: 500 Internal Server Error, request id: req_1";
  const output = `${thread}\n${JSON.stringify({ type: "turn.failed", error: { message } })}`;
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({
    _tag: "Failed",
    session: Option.some(session),
    kind: "other",
    message,
    resets: Option.none(),
  });
});

it("a Codex Turn with no turn.completed has no end", () => {
  // Given
  const harness = makeCodexHarness();
  const output = [
    thread,
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"working"}}',
  ].join("\n");
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({ _tag: "NoEnd" });
});

it("Codex reads the end past a cut trailing event", () => {
  // Given
  const harness = makeCodexHarness();
  const output = `${done}\n{"type":"item.comp`;
  // When
  const end = harness.readEnd(output);
  // Then
  expect(end).toEqual({ _tag: "Done", session, lastMessage: "made hello.txt" });
});

it("a Codex completion without a thread has no end", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const end = harness.readEnd('{"type":"turn.completed"}');
  // Then
  expect(end).toEqual({ _tag: "NoEnd" });
});

it("a Codex completion with no agent message has empty last text", () => {
  // Given
  const harness = makeCodexHarness();
  // When
  const end = harness.readEnd(`${thread}\n{"type":"turn.completed"}`);
  // Then
  expect(end).toEqual({ _tag: "Done", session, lastMessage: "" });
});
