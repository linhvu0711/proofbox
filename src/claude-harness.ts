import { Option } from "effect";
import type { Harness } from "./harness.ts";
import { shellJoin } from "./shell.ts";

export const makeClaudeHarness = (): Harness => ({
  name: "claude",
  install: (version) =>
    `set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://claude.ai/install.sh -o "$f"; bash "$f"${Option.isSome(version) ? ` ${shellJoin([version.value])}` : ""}`,
  home: ".claude",
  homeEntries: [".claude.json", ".local", ".cache"],
  instructionsFile: "CLAUDE.md",
  // Stand-in replaced by #193.
  turn: () => ["claude", "--version"],
  // Stand-in replaced by #193.
  readEnd: () => ({ _tag: "NoEnd" }),
  readActivity: () => Option.none(),
});
