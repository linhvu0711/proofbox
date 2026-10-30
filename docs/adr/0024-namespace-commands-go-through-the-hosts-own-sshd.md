# Namespace commands go through the host's own sshd

Supersedes ADR 0022.

Namespace's own SSH server sometimes never ends a session. This is the program behind the Namespace ssh gateway: `/opt/namespace/vmguest` on a Mac (issue #118), and `nscinit` on a Linux host. It can also hold back the last few 32 KB blocks of stdout. On Linux the hang comes when stderr follows a lot of stdout. proofbox's command checks (ADR 0015) always end with a stderr trailer, so every Keeper call has that shape (issue #251). On one Linux host on 2026-10-30, we ran proofbox's exact remote line with a 3.1 MB `cat` 20 times each way. Through the gateway, 8 runs hung. Through an OpenSSH server on the host, reached with `-W` over the same gateway, 0 runs hung. The same Mac ssh client hung 0 times in 60 against a local OpenSSH server.

So `create` uses the gateway only to set up the host's own sshd, on both OSes. On a Mac it turns on the Mac's sshd, as before. On a Linux host it installs `openssh-server` with `apk` and starts sshd on `127.0.0.1:22`. It adds the per-Sandbox key that `create` already makes to `authorized_keys`, and pins the sshd host key. Every later call goes through sshd: exec, helper calls, and the rest of the setup steps. If sshd cannot be set up, `create` fails and deletes the Sandbox. It never falls back to the gateway. A Sandbox made by an older proofbox has no sshd, so a call on it fails and says to delete it and create a new one. The Live view keeps its own gateway forward. The helper time limits of ADR 0019 stay.

## Considered options

- Keep Linux on the gateway and shorten the download "no bytes" limit: rejected. A plain `exec` has no limit and would still hang forever, and every hang would still cost the wait.
- Ship our own sshd binary to the host, or run sshd in a second container: rejected. The host's package manager installs a maintained sshd in a few seconds. A container would need its own way to reach Docker.
- Fall back to the gateway for older Sandboxes: rejected, as in ADR 0022. The hang would come back with no sign of why, and the code would keep two link paths.
