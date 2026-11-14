# proofbox verifies; it does not write code

proofbox only rents a Sandbox, runs the app, drives its screen, and brings back proof. Writing code stays wherever the Caller already works (a laptop, a server, any harness). We rejected a Devin-style "whole session in the cloud" tool because it duplicates the harness, needs the model and the repo credentials inside the Sandbox, and bills Sandbox minutes while the model thinks about code.

In October 2026 we tried the opposite on a side branch (epic #188), with Claude Code or Codex writing code inside the Sandbox. We dropped it in November 2026, and it never reached main. Tag `archive/harness` keeps its last code.
