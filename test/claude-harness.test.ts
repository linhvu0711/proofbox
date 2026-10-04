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

it("Claude's last activity names its last tool and what it ran on", () => {
  // Given
  const output = `{"type":"assistant","message":{"content":[{"type":"text","text":"Running the tests."},{"type":"tool_use","name":"Bash","input":{"command":"pnpm test\\necho done"}}]}}\n{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}`;
  // When
  const result = makeClaudeHarness().readActivity(output);
  // Then
  expect(result).toEqual(Option.some("Bash: pnpm test"));
});

it("Claude's activity skips thinking and cuts long first lines", () => {
  // Given
  const output = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a".repeat(121) + "\nsecond line" }] } })}\n{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"}]}}\n{"type":"assist`;
  // When
  const result = makeClaudeHarness().readActivity(output);
  // Then
  expect(result).toEqual(Option.some("a".repeat(119) + "…"));
});

it("Claude's activity has no entry when only thinking is present", () => {
  // Given
  const output = `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"}]}}`;
  // When
  const result = makeClaudeHarness().readActivity(output);
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
