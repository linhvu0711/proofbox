# Decisions after the Namespace test

Settled 2026-09-27 in the tool grill, after the Namespace live test (`docs/research/namespace-test.md`). The ADRs in `docs/adr/` record the ones that are hard to reverse.

## From the Namespace test

1. **Namespace workload token.** Every machine holds a strong account token that lasts 24.5 h, even after the machine is deleted, and cannot be revoked from the CLI. User code must never reach it: on Linux, the app runs only in the container; on macOS, delete the token file before upload. Decided 2026-09-27: `create` checks that the token file is gone and the token service is unreachable from where user code runs, and refuses the Sandbox if not.
2. **macOS privacy locks.** Run GUI commands in the user's desktop session (`launchctl asuser`), grant screen and input access to `/opt/namespace/vmguest` in TCC.db, and pre-answer the replayd "bypass the private window picker" alert. Decided 2026-09-27: `create` ends with a test screenshot and a 1 s test capture, and fails clearly if either is blocked or an alert is on screen.
3. **No Homebrew.** proofbox brings its own pinned tools (static ffmpeg, its own input helper). Decided 2026-09-27: a Tool bundle (see CONTEXT.md) with fixed hashes, defined by the core. How it reaches a Sandbox is a Provider choice, so other platforms can do it their own way. Namespace macOS: `nsc artifact cache-url`, before the token is deleted and before any user code arrives.
4. **Slow link and slow commands.** Build the Proof video in the Sandbox and download only that. Decided 2026-09-27: a Keeper per Sandbox on the Caller's machine holds one open connection (see CONTEXT.md). The Sandbox id stays the source of truth.
5. **One Mac at a time** on the current plan (6 vCPU / 14 GiB macOS quota). The published Developer limit is 12 vCPU / 28 GB; ask support to raise it. Decided 2026-09-27: stay on Developer (pay as you go) for now. The user needs at least 6 Macs at once later, which means Team ($100/month, 24 vCPU: exactly 6 small 4x7 Macs). proofbox must report the provider's `ResourceLimitsError` clearly. Still to test: is the small 4x7 Mac fast enough.

## Checking again after a failure

6. Send only changed files to a running Sandbox (sync), so a second check does not start from zero. Decided 2026-09-27: the Sandbox keeps a list of file hashes from the last upload; the next upload sends only changed and new files and removes deleted ones.
7. On macOS, starting again (about 1 min, about $0.06) is cheaper than waiting through a 10-minute fix (about $0.60). Make re-create fast, and let the Caller set a shorter Deadline per OS. Decided 2026-09-27: idle time default 5 min on macOS, 15 min on Linux, set by the Caller on `create`.

8. A failed walk must not become proof: a way to discard a Recording, while the raw Recording and app logs stay for debugging. Decided 2026-09-27: `record stop --discard` makes no Proof video; the raw Recording and logs stay in the Sandbox until it is deleted.

## Proof video a human can follow

9. The user watched the prototypes: too fast to follow. Decided 2026-09-27, two parts, both in the tool, with defaults the Caller can change:
   - Human pace during the walk: the mouse glides (about 0.4 s), typing at about 80 ms per letter (at most about 3 s per field), and about 0.7 s wait after each action.
   - Video edit: 1 s before each change and 2 s after the screen settles, a 2 s result hold at the end of each Step, a ring at each click (from the Action log), a caption bar that stays for the whole step, a 2 s "» N s later" label, and at least 3 s per step.
   - Captions sized from the video width.

## Secrets on macOS

10. Decided 2026-09-27: no container on the Mac, so the env file goes into a RAM disk (`hdiutil attach -nomount ram://…`), mode 600, owned by `runner`. It is sent at the same point as on Linux: after the Setup script has finished, so setup never sees it. It is gone when the Mac is deleted. macOS has no Snapshots, so nothing can carry it forward.
