import { Option } from "effect";
import { expect, it } from "vitest";
import { makeClaudeHarness } from "../src/claude-harness.ts";

it("a Claude Turn runs headless with all permissions", () => {
  // Given
  const harness = makeClaudeHarness();
  // When
  const argv = harness.turn({
    prompt: "make hello.txt",
    model: Option.none(),
    session: Option.none(),
  });
  // Then
  expect(argv).toEqual([
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--",
    "make hello.txt",
  ]);
});

it("a Claude Turn resumes its session with the model it is given", () => {
  // Given
  const harness = makeClaudeHarness();
  // When
  const argv = harness.turn({
    prompt: "-v",
    model: Option.some("opus"),
    session: Option.some("s1"),
  });
  // Then
  expect(argv).toEqual([
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--resume",
    "s1",
    "--",
    "-v",
  ]);
});

it("Claude's step for a tool call names the tool and its whole main input", () => {
  // Given
  const event = `{"type":"assistant","message":{"content":[{"type":"text","text":"Running the tests."},{"type":"tool_use","name":"Bash","input":{"command":"pnpm test\\necho done"}}]}}`;
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(
    Option.some({ kind: "tool", text: "Bash: pnpm test\necho done" }),
  );
});

it("Claude's step for a message is its text", () => {
  // Given
  const event = `{"type":"assistant","message":{"content":[{"type":"text","text":"Running the tests."}]}}`;
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(
    Option.some({ kind: "said", text: "Running the tests." }),
  );
});

it("Claude has no step for thinking", () => {
  // Given
  const event = `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"}]}}`;
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.none());
});

it("Claude has no step for a cut event", () => {
  // Given
  const event = '{"type":"assist';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.none());
});

it("Claude's step for the start names the model", () => {
  // Given
  const event =
    '{"type":"system","subtype":"init","model":"claude-opus-5-5","session_id":"s1","cwd":"/work","tools":[]}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(
    Option.some({ kind: "other", text: "started: claude-opus-5-5" }),
  );
});

it("Claude's step for a tool result is its output", () => {
  // Given
  const event =
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.some({ kind: "result", text: "result: ok" }));
});

it("Claude's step for a failed tool joins its text blocks", () => {
  // Given
  const event =
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"Exit code 1"},{"type":"text","text":"not found"}]}]}}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(
    Option.some({ kind: "result", text: "error: Exit code 1\nnot found" }),
  );
});

it("Claude's step for an API retry names the attempt and the error", () => {
  // Given
  const event =
    '{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":4000,"error_status":529,"error":"overloaded"}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(
    Option.some({ kind: "other", text: "API retry 2: overloaded" }),
  );
});

it("Claude has no step for the result event", () => {
  // Given
  const event =
    '{"type":"result","subtype":"success","is_error":false,"result":"Made hello.txt.","session_id":"s1"}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.none());
});

it("Claude has no step for the prompt it was sent", () => {
  // Given
  const event = '{"type":"user","message":{"role":"user","content":"hi"}}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.none());
});

it("Claude has no step for other system events", () => {
  // Given
  const event = '{"type":"system","subtype":"compact_boundary"}';
  // When
  const result = makeClaudeHarness().readStep(event);
  // Then
  expect(result).toEqual(Option.none());
});

it("a refused Claude login reads as a login failure", () => {
  // Given
  const output = `{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed","session_id":"7f1c2d3e-0000-4000-8000-000000000001"}\n{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid.","session_id":"7f1c2d3e-0000-4000-8000-000000000001"}`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({
    _tag: "Failed",
    session: Option.some("7f1c2d3e-0000-4000-8000-000000000001"),
    kind: "login",
    message:
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    resets: Option.none(),
  });
});

it("a Claude usage limit reads with its reset time", () => {
  // Given
  const output = `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 10:10pm (Europe/Kiev)","session_id":"s1"}`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({
    _tag: "Failed",
    session: Option.some("s1"),
    kind: "usage-limit",
    message: "You've hit your session limit · resets 10:10pm (Europe/Kiev)",
    resets: Option.some("10:10pm (Europe/Kiev)"),
  });
});

it("a Claude Turn is done when its last result event is not an error", () => {
  // Given
  const output = `{"type":"system","subtype":"api_retry","error_status":401,"session_id":"s1"}\n{"type":"result","subtype":"success","is_error":false,"result":"Made hello.txt.","session_id":"s1"}`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({
    _tag: "Done",
    session: "s1",
    lastMessage: "Made hello.txt.",
  });
});

it("a Claude Turn with no result event has no end", () => {
  // Given
  const output = `{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"assist`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({ _tag: "NoEnd" });
});

it("a Claude usage limit can give an epoch reset time", () => {
  // Given
  const output = `{"type":"result","is_error":true,"api_error_status":429,"result":"usage limit|1791169200","session_id":"s1"}`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({
    _tag: "Failed",
    session: Option.some("s1"),
    kind: "usage-limit",
    message: "usage limit|1791169200",
    resets: Option.some("2026-10-05T03:00:00Z"),
  });
});

it("Claude reads the last decodable result and ignores a cut trailing event", () => {
  // Given
  const output = `{"type":"result","is_error":true,"api_error_status":500,"result":"old failure","session_id":"s1"}\n{"type":"result","is_error":false,"session_id":"s1"}\n{"type":"result","is_error":"invalid"}\n{"type":"assist`;
  // When
  const result = makeClaudeHarness().readEnd(output);
  // Then
  expect(result).toEqual({ _tag: "Done", session: "s1", lastMessage: "" });
});
