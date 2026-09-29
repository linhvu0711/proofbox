# proofbox grants itself macOS screen and input access on each Mac

A command over `nsc ssh` runs outside the desktop session and has no screen or input permission, and macOS 26 also shows a "bypass the system private window picker" alert that waits for a click. On every Mac, proofbox therefore:

- runs desktop commands in the user's session (`sudo launchctl asuser 501 sudo -u runner …`),
- grants `kTCCServiceScreenCapture`, `kTCCServiceAccessibility`, and `kTCCServicePostEvent` to `/opt/namespace/vmguest` in the system TCC database (possible because SIP is off and sudo needs no password),
- writes an approval for `/opt/namespace/vmguest` in `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist` before the first capture, with every date replayd itself writes, then stops replayd with `kill -9` so it reads the file again (replayd is already running at boot, keeps approvals in memory, and saves them over the file on a normal stop).

This edits private macOS files on purpose, so it can break with a macOS update. `create` ends with a test screenshot and a 1-second test capture and fails clearly when either is blocked or an alert is on screen. The capture does not wait on the replayd alert, so a replayd that moved the approval's hint date also counts as an alert. Details: `docs/research/namespace-test.md`.
