import { Option } from "effect";
import type { Harness } from "./harness.ts";
import { shellJoin } from "./shell.ts";

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
  readEnd: () => ({ _tag: "NoEnd" }),
  readSteps: () => [],
});
