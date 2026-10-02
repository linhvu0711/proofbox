# Namespace live test

Date: 2026-09-27. For: proofbox v1 design grill. Region: iad4 (US East). nsc v0.0.578.

All numbers are from real runs on the Personal workspace. Scripts: `proofvideo.py` and `mac-prepare.sh` in the session scratchpad (prototypes, not kept).

## What works

| Check | Linux (bare 2x4) | macOS 26.3.1 (6x14) |
|---|---|---|
| Create to SSH ready | 3 s | 10 s |
| One `nsc ssh` command, round trip | 3.7–4.9 s | about 5.5 s |
| Deadline push (`nsc extend --ensure_minimum 15m`) | 1.5 s, prints the new deadline | same |
| Auto-delete at the deadline | yes, to the second (2 min test) | not tested separately, same control plane |
| Desktop | our own: Docker container with Xvfb 1440x900, fluxbox, x11vnc, Chromium. Install 28 s | logged-in Aqua session, user `runner`, 1280x800 points at 2x (2560x1600 pixels) |
| Screenshot | `import -window root` in the container | `screencapture` after the Mac prepare step (below) |
| Pointer and keys | xdotool: click, type, key, scroll all work | cliclick: click, type, key work. Scroll needs our own CGEvent helper (Swift, 3 s to build) |
| Recording | ffmpeg x11grab, 30 fps, real speed | ffmpeg avfoundation, 27–30 fps, speed 0.996x, 0 drops |
| Live view | x11vnc through `nsc instance port-forward` to a relay on the host private IP. VNC password. Not public | `nsc instance port-forward --target_port 5900` reaches Apple Screen Sharing (auth types 30/33/35/36). `nsc vnc` is macOS-only. Not public |
| Work folder upload (tar over `nsc ssh` stdin) | perch, 258 files, 0.34 MB: 10 s | clocktrace, 267 files, 2.2 MB: 8 s |
| Real setup | perch `bun install`: 1.2 s | clocktrace `pnpm install` (pnpm preinstalled): 7 s cold |
| Snapshot | `docker commit` 47 s (2.45 GB), push to `nscr.io/<tenant>/…` 4 s, pull on a fresh host 12 s. Fresh host to ready desktop: 24 s | none. Cache volume (`--volume cache:tag:path:size`) mounts fine on macOS |
| Secrets | env file over SSH stdin into a container tmpfs (mode 0700). Not in `docker commit` output | not tested |

## Proof video prototype

- Still parts found with ffmpeg `freezedetect=n=0.001:d=3`. Small changes like the clock stay under the limit.
- Linux: 219 s raw became 13.4 s, 0.58 MB, H.264 High yuv420p 1440x900. Built in the Sandbox in 18 s.
- macOS: 101 s raw became 18.6 s, 0.97 MB, scaled to 1440 wide. Built in 12 s.
- Captions must scale with the frame width. A fixed 26 px font was too small after the 2560 to 1440 scale.

## Problems found

1. **Namespace workload token.** Every instance has `/var/run/nsc/token.json`, readable by all users, and the Linux host also has it in `~/.docker/config.json`. It has `instance/* *`, `ingress *`, `containerregistry/* *`, `federation/* issue_token`, `artifact *`, `cache/* *`, and more. It is valid for 24.5 h, it works from outside the instance, it **still works after the instance is destroyed**, and `nsc token list` does not show it, so it cannot be revoked from the CLI.
   - Linux host: `http://169.254.169.42/latest/workload_token` gives a new token on request.
   - Linux app container (default bridge, no mounts): cannot see the file and cannot reach the service.
   - macOS: the service is not reachable, even as root. Deleting `token.json` and the Docker config works, nothing breaks, and it did not come back in 15 min. The app user `runner` has passwordless sudo, so the file must be gone before any user code runs.
2. **macOS privacy (TCC).** `screencapture` from SSH fails with "could not create image from display" for two reasons. Both fixes are needed:
   - Run in the GUI session: `sudo launchctl asuser 501 sudo -u runner <cmd>`.
   - Grant `kTCCServiceScreenCapture`, `kTCCServiceAccessibility`, and `kTCCServicePostEvent` to `/opt/namespace/vmguest` in the system TCC.db. SIP is disabled and sudo needs no password, so this works.
   - Apple Events (Automation) consent is per user and per target app. `kTCCServiceAppleEvents` rows for `/opt/namespace/vmguest` work in runner's TCC.db with no `tccd` restart; rows in the system TCC.db still show the dialog. A dialog already on screen keeps blocking its app after the row is written. Checked on macOS 26.3.1, 2026-10-02 (#120).
3. **macOS "bypass the private window picker" alert.** On macOS 26 the first capture shows "vmguest is requesting to bypass the system private window picker…" and waits for Allow. Writing an entry for `/opt/namespace/vmguest` in `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist` (far-future `kScreenCapturePrivacyHintDate`) before the first capture stops it. Checked on a fresh Mac across a 58 s recording.
4. **Homebrew is not reliable.** On one of two Macs, `brew install ffmpeg-full` failed with `undefined method '[]' for nil` in `load_tab`, with or without the cache volume. The core `ffmpeg` bottle has no `drawtext`. A static build (martin-riedl.de, ffmpeg 9.0.2, 66 MB) downloads in 5 s and has `drawtext`, `freezedetect`, and `avfoundation`.
5. **Slow link to the Caller.** Download from iad4 to the Caller in UTC+7 is about 0.45 MB/s (18 MB in 40 s, both `nsc instance download` and `ssh cat`). Build the Proof video in the Sandbox and download only that.
6. **Slow commands.** Each `nsc ssh` call costs about 4 s. A pixel loop (action, then screenshot, then download) took 11 s. proofbox needs a kept-open channel.
7. **macOS quota.** The workspace allows 6 vCPU / 14 GiB of macOS, so only one 6x14 Mac runs at a time. Linux allows 32 vCPU.
8. **Work folder without `.git`.** clocktrace's postinstall printed "not a git checkout, nothing to do". Some repo scripts act differently without `.git`.
9. **Port forward reaches the host private IP only.** A container port bound to `127.0.0.1` on the host cannot be forwarded. A relay on the host was needed.

## Cost of this test

`nsc instance report` gives minutes, not dollars. Linux: 48 min on 2x4 (96 unit-minutes), $0.10–0.14. macOS: 36.1 min on 6x14 (15.2 + 20.9), $2.17–3.25 at $0.06–0.09/min, the prepaid and overage rates for 6x14 on https://namespace.so/pricing. Most of the Mac time was debugging between commands, not the checks. The dashboard bill has the final number.

## Size test, 2026-09-28

Question: can the small sizes (macOS 4x7, Linux 2x4 or 4x8) install, build, and run real projects, with the screen recorded at the same time? Scripts: `mac-bench.sh`, `mac-heavy.sh`, and `linux-heavy.sh` in the session scratchpad (not kept). Region iad4. Recording in every run: ffmpeg, 30 fps, libx264 ultrafast, CRF 18.

macOS 4x7 (4 vCPU, 7 GB, macOS 26.3.1, Xcode 26.1.1, Swift 6.2.1):

| Work | Time | Recording at the same time | RAM |
|---|---|---|---|
| clocktrace `pnpm install` | 7 s | | |
| clocktrace `pnpm -r run build` (tsc and `swift build -c release`) | 8 s | | |
| swift-format 602.0.0 `swift build` (debug) | 52 s | 1796 frames in 60 s, speed 0.999x, load about 10 | 67% free at worst, no swap |
| swift-format 602.0.0 `swift build -c release` | 170 s | 3600 frames in 120 s, speed 0.999x | 51% free at worst, no swap |

A frame from the release-build recording showed the real desktop.

Linux, in a `debian:bookworm` container on a bare host, with Xvfb 1440x900, fluxbox, and Chromium on a page:

| Work | 2x4 | 4x8 |
|---|---|---|
| Desktop `apt-get install` | 30 s | 25 s |
| perch `bun install` | 1 s | 1 s |
| perch `bun run build` | 7 s | 5 s |
| ripgrep 14.1.1 `cargo build --release` | 30 s | 16 s |
| typst v0.13.1 `cargo build --release -p typst-cli` | 222 s | 134 s |
| Recording during the typst build | 3600 frames in 120 s, 1x | 3600 frames in 120 s, 1x |
| RAM during the typst build | peak 2876 MB used, 1099 MB left | peak 3298 MB used, 4703 MB left |
| Out-of-memory kills | 0 | 0 |

What it shows:

- Recording held 30 fps in every run, even with all CPUs busy.
- CPU changes build time only. 4x8 built typst 40% faster than 2x4.
- RAM is what can fail a run. 2x4 had 1.1 GB left with a mid-size Rust build and Chromium, so a large web build (a big Next.js app needs 2 to 4 GB of heap) can run out there.
- The Mac left idle until its Deadline cost about 25 extra minutes. proofbox deletes a Sandbox when its work ends, so this does not apply to real runs.

## Open

- Nearer regions than iad4 for a Caller in UTC+7 (`--region` exists, not tested).
- Secrets on macOS (no container there, so tmpfs and user isolation need a design).
