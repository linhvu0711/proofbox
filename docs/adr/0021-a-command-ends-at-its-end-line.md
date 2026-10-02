# A command ends at its End line, not at the ssh exit

On a Namespace Mac, `/opt/namespace/vmguest` (the program that runs our ssh commands) sometimes never ends the session after a command has exited. Sometimes it also drops the last few KB of stdout. In tests on 2026-10-02, `exec cat` of a 3.5 MB file hung 8 times in 25. One of those 8 was short by 32 KB. Plain `cat` over raw ssh, with no `sudo` and no `launchctl`, hung too (issue #118). The Keeper waited for the ssh exit, so `exec` waited forever. ADR 0019 covers helper calls only.

So the script around each command writes an End line after the command: its exit code, how many bytes of stdout it made, and the memory-kill counts. A command ends when its End line has arrived and its stdout has reached that byte count. It does not wait for the ssh exit. Once all its stdout is in, it waits at most 1 s more for the link to close, so the Keeper log can tell a Mac that did not close; then it ends anyway. If stdout is still short 5 s after the End line, the call fails with exit 125. The error says the command did run, and running it again runs it twice. The same rule holds on Linux. The helper time limits of ADR 0019 stay as a safety net for a call whose End line never arrives.

## Considered options

- Run commands through the Mac's own OpenSSH server over a forwarded port, so vmguest only passes TCP bytes: rejected. The Mac runs no sshd (docs/test-decisions.md), so proofbox would have to turn on Remote Login, manage one more key, and add a second link path. Nothing showed that this stops the stall.
- A no-new-bytes limit on `exec`: rejected again, for the reason in ADR 0019. A real command can be quiet for many minutes.
- Succeed with a warning when stdout is short: rejected. A script that only reads the exit code would take the cut output as the full answer.
- A long limit only for a call whose End line never arrives: not built. No stall so far lost the End line, and the only fix is the limit rejected above.
