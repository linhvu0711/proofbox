import { Option } from "effect";
import { expect, it } from "vitest";
import { makeCodexHarness } from "../src/codex-harness.ts";

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
