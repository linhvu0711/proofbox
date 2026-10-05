# A Harness can write code in the Sandbox

Supersedes ADR 0001. Changes ADR 0002 and ADR 0005.

proofbox can now install a Harness (Claude Code or Codex first, more later) in a Sandbox and run it there. The Caller sends it a prompt, waits for the Turn to end, checks the result in the same Sandbox, and sends the problems back as the next prompt. The verify-only loop cannot give two things we want. The Harness runs with all permissions on a throwaway machine, so the app's dependencies and builds never land on the Caller's laptop. And each task gets its own Sandbox, so several run at once.

The Caller still drives everything from outside, as ADR 0002 says, but a Harness that reasons now runs inside the Sandbox. We accept the costs ADR 0001 named. The Sandbox bills while the model thinks, about $1.20 to $1.80 for a 20-minute Turn on a Mac. A Harness login and a GitHub login enter the Sandbox (ADR 0024).

The shape:

- One Harness session per Sandbox, named by the Sandbox id. Parallel work means more Sandboxes.
- `harness prompt` starts a Turn and returns at once. `harness wait` blocks until the Turn ends, can run again with no harm after the Caller's shell time limit, and pushes the Deadline while it runs, so a dead laptop still lets the Sandbox die at its Deadline (ADR 0003). `harness wait --timeout` returns early with the last activity, and the Caller decides whether to `harness stop`. A prompt while a Turn runs is refused.
- A failed Turn ends with its reason and fix (login refused, usage limit, Harness crash), each with its own exit code: login refused 21, usage limit 22, Harness crash 23. `stopped` is 20 and `still running` is 124, so all stay outside Node's own 1 and 3 to 14.
- Each Sandbox installs the newest version of the Harness. proofbox reads only the process exit and the final result event, plus the last events for `harness wait --timeout`, and keeps no list of models, so `--model` goes straight to the Harness. `--harness-version` goes back to an older version when the newest one breaks.
- The Work folder is the Caller's branch cloned from GitHub, with the unpushed commits and uncommitted files put on top. `git` and `gh` with the GitHub login are there, and the Harness commits, pushes, and opens pull requests when the prompt asks. proofbox makes no branch, checks no push, and reads nothing from GitHub after a Turn. `upload` still works at any time; the Caller and the Harness agree on who changes what.
- The Caller's own config reaches the Harness only through a Harness profile, copied in after any Snapshot. On Linux the Sandbox user still has no sudo, so system packages go in the Setup script. The Harness does not drive the screen.

## Considered options

- Hands-off, so the loop goes on with the laptop closed: rejected for now. The Caller must run somewhere, and a remote Caller means a server, which ADR 0014 rejects. Claude Code on the web and Codex cloud already sell that shape.
- proofbox runs the loop itself: rejected. proofbox would become the agent that reasons.
- Many Harness sessions in one Sandbox: rejected. They change the same folder, so their work mixes and one broken build stops all of them.
- A pinned Harness version: rejected. New models need new Harness versions, and they come every few weeks.
- A watchdog in the Sandbox that keeps it alive while the Harness runs: rejected. A stuck Harness would keep a Mac alive until Max life, and the watchdog would need the Provider login inside.
- A Turn time limit in proofbox: rejected for the reason in ADR 0019. A real Turn can wait many quiet minutes on a test run.
- Copy the Caller's whole `~/.claude/` or `~/.codex/`: rejected. Hooks and MCP servers point to programs on the laptop, MCP config can hold tokens, and rules written for a person (for example "use `pbcopy`") do not fit a Harness that talks to the Caller.
