# Decisions after the Namespace test

Settled 2026-09-27 in the tool grill, after the Namespace live test (`docs/research/namespace-test.md`). The ADRs in `docs/adr/` record the ones that are hard to reverse.

## From the Namespace test

1. **Namespace workload token.** Every machine holds a strong account token that lasts 24.5 h, even after the machine is deleted, and cannot be revoked from the CLI. User code must never reach it: on Linux, the app runs only in the container; on macOS, delete the token file before upload. Decided 2026-09-27: `create` checks that the token file is gone and the token service is unreachable from where user code runs, and refuses the Sandbox if not.
2. **macOS privacy locks.** Run GUI commands in the user's desktop session (`launchctl asuser`), grant screen and input access to `/opt/namespace/vmguest` in TCC.db, and pre-answer the replayd "bypass the private window picker" alert. Decided 2026-09-27: `create` ends with a test screenshot and a 1 s test capture, and fails clearly if either is blocked or an alert is on screen.
3. **No Homebrew.** proofbox brings its own pinned tools (static ffmpeg, its own input helper). Decided 2026-09-27: a Tool bundle (see CONTEXT.md) with fixed hashes, defined by the core. How it reaches a Sandbox is a Provider choice, so other platforms can do it their own way. Namespace macOS: `nsc artifact cache-url`, before the token is deleted and before any user code arrives.
4. **Slow link and slow commands.** Build the Proof video in the Sandbox and download only that. Decided 2026-09-27: a Keeper per Sandbox on the Caller's machine holds one open connection (see CONTEXT.md). The Sandbox id stays the source of truth.
5. **The Namespace plan limits how many Macs run at once.** The test workspace had a 6 vCPU / 14 GiB macOS quota, so one Mac at a time. The published Developer limit is 12 vCPU / 28 GB, and Team gives 24 vCPU (6 small 4x7 Macs). Decided 2026-09-27: proofbox does not depend on a plan, and it reports the provider's `ResourceLimitsError` clearly. The size test on 2026-09-28 answered the open question: the small 4x7 Mac is fast enough (item 11).

## Checking again after a failure

6. Send only changed files to a running Sandbox (sync), so a second check does not start from zero. Decided 2026-09-27: the Sandbox keeps a list of file hashes from the last upload; the next upload sends only changed and new files and removes deleted ones.
7. On macOS, starting again (about 1 min, about $0.06) is cheaper than waiting through a 10-minute fix (about $0.60). Make re-create fast, and let the Caller set a shorter Deadline per OS. Decided 2026-09-27: idle time default 5 min on macOS, 15 min on Linux, set by the Caller on `create`.

8. A failed run must not become proof: a way to discard a Recording, while the raw Recording and app logs stay for debugging. Decided 2026-09-27: `record stop --discard` makes no Proof video; the raw Recording and logs stay in the Sandbox until it is deleted.

## Proof video a human can follow

9. The user watched the prototypes: too fast to follow. Decided 2026-09-27, two parts, both in the tool, with defaults the Caller can change:
   - Human pace during Pixel actions: the mouse glides (about 0.4 s), typing at about 80 ms per letter (at most about 3 s per field), and about 0.7 s wait after each action.
   - Video edit: 1 s before each change and 2 s after the screen settles, a 2 s result hold at the end of each Step, a ring at each click (from the Action log), a caption bar that stays for the whole step, a 2 s "» N s later" label, and at least 3 s per step.
   - Captions sized from the video width.

## Secrets on macOS

10. Decided 2026-09-27: no container on the Mac, so the env file goes into a RAM disk (`hdiutil attach -nomount ram://…`), mode 600, owned by `runner`. It is sent at the same point as on Linux: after the Setup script has finished, so setup never sees it. It is gone when the Mac is deleted. macOS has no Snapshots, so nothing can carry it forward.

## Sandbox size

11. The size test (`docs/research/namespace-test.md`, 2026-09-28) showed that CPU changes only how long a build takes, and RAM decides whether it works. No one size fits every project. Decided 2026-09-28:
    - Defaults: macOS 4x7, Linux 4x8. The 4x7 Mac is the only size that fits 6 Macs in the Team plan's 24 vCPU. Linux 4x8 costs about $0.004/min, and 8 of them fit the Developer plan's 32 vCPU.
    - The Caller picks another size with `create --size <cpu>x<ram>`. A size the Provider does not offer is refused, and the error lists the sizes it does offer.
    - Sizes go up in this order: Linux 4x8, 8x16, 16x32; macOS 4x7, 6x14.
    - A command killed for lack of memory fails with its own exit code and a plain message that names the size and the next one up, for example `Sandbox ran out of memory (4x8). Try --size 8x16.` At the largest size, the message says so.
    - A bigger Mac uses more of the macOS quota, so fewer Macs run at once.

## The SSH link

12. Instances made through the Compute API run no sshd on port 22, so `nsc instance port-forward --target_port 22` cannot carry the link (verified live 2026-09-30: the forward answers with a reset, `nsc ssh` and `instance proxy -s ssh` fail the same way). Decided 2026-09-30: the link uses `ComputeService.GetSSHConfig` — an ephemeral key, the username, and the `ssh.<region>.namespace.so` gateway endpoint — with the returned host keys pinned in a per-Sandbox known_hosts file (`StrictHostKeyChecking=yes`). The Live view forwards the same way: `nsc instance port-forward` accepts a local connection but its remote dial dies with `websocket: bad handshake` under an instance-grant token, so `ssh -N -L` over the gateway carries 5900 instead (verified live 2026-09-30: the RFB greeting arrives). `nsc` then stays only for Snapshot expiry (`registry update-image-expiration`). `GetSSHConfig`'s `sshHostKeys` field is ahead of the SDK's generated proto, so that one call goes over Connect JSON directly.

## Tokens without claims

13. Real revocable tokens are opaque (`nsrt_…`; `tokens_pb.ts` `CreateRevokableToken`), and no public IAM call introspects one with an instance-only grant — so rejecting tokens with no readable claims would refuse the tokens users actually mint. Decided 2026-09-30: a token with no readable claims is checked with the one `ListInstances` call and saved; account and expiry stay unknown, and the login and status lines say `token …<last4>` and `expiry not known`. A claims-bearing token (`nsct_` and friends) still shows its `tenant_id` and `exp`.
