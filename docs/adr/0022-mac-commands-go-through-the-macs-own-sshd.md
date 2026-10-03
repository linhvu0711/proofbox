# Mac commands go through the Mac's own sshd

Supersedes ADR 0021.

On a Namespace Mac, `/opt/namespace/vmguest` (the program behind the Namespace ssh gateway) sometimes never ends a session, and sometimes it holds back the last 16 to 64 KB of stdout or stderr (issue #118). An End line on stderr can be held back too, so ADR 0021's plan did not stop the hang: on 2026-10-02, 3 of 25 calls still hung on the branch that built it. On one Mac on 2026-10-03, we ran proofbox's exact remote line with a 3.5 MB `cat` 25 times each way. Through vmguest, 7 runs hung. Through the Mac's own OpenSSH server, reached with `ProxyJump` over the same gateway, 0 runs hung.

So `create` uses vmguest only to turn on the Mac's sshd. It adds the per-Sandbox key that `create` already makes to `runner`'s `authorized_keys`, and pins the sshd host key. Every later Mac call goes through sshd: exec, helper calls, and the rest of the setup steps. sshd gets the same TCC rows as vmguest, and the same replayd pre-answer. Without them, `screencapture` fails and the capture and Apple Events calls hang. With the rows but no pre-answer, macOS shows "com.apple.sshd-session is requesting to bypass the system private window picker". If sshd cannot be turned on, `create` fails and deletes the Mac; it never falls back to vmguest. A Mac made by an older proofbox has no sshd, so a call on it fails and says to delete it and create a new one. Linux and the Live view do not change. The helper time limits of ADR 0019 stay.

## Considered options

- End a command at its End line (ADR 0021): rejected. The End line goes through vmguest too, and it was held back in live runs.
- Count stdout bytes on the Mac and fail with exit 125 when bytes are lost: not kept. The inner ssh session over sshd already fails on lost or changed bytes.
- Fall back to vmguest when sshd cannot be turned on, or for an older Mac: rejected. The hang would come back with no sign of why, and two link paths would stay in the code. A Mac lives 3 hours at most, so older Macs are gone soon.
