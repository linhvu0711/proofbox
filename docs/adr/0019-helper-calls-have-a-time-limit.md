# Helper calls have a time limit, and only read-only calls retry

On a Namespace Mac, the program that runs our commands (`/opt/namespace/vmguest`) sometimes never sends the last 20 to 50 KB of a command's stdout and never ends the session. In tests on 2026-10-01 this happened to about 1 Mac screenshot in 5. The command and all its processes had already exited, and its last stderr line had arrived. Without a limit, the Caller then waits forever (issue #91).

So the CLI gives each helper call a time limit: 120 s plus the command's own pace time for short calls, 120 s plus the Recording's length to check and build a Proof video, and 120 s with no new bytes for a download. A call that only reads (a screenshot, a download) tries once more. A call that changes something (click, type, key, scroll, drag, mark, record start, record stop) never tries again, and its error says the action may have happened. When the Caller leaves, the Keeper ends that command, so it stops pushing the Deadline. The Keeper writes a log with one line per command. A line holds the command name and how it ended, and never the arguments, the input, or the output.

## Considered options

- A timer in the helper script on the Sandbox: rejected. When `vmguest` stalls, the script has already finished, so a timer there never fires.
- Retry every helper call: rejected. If a click happened and only its answer got lost, a retry clicks twice.
- Log full command lines: rejected. `type` text and `exec` arguments can hold a password or a token, and a Secret must never sit in a file on the Caller's machine.
- A limit on `exec`: rejected for now. User commands can run, and stay silent, for many minutes, so no limit is safe for all of them.
