# proofbox grants itself macOS screen and input access on each Mac

A command over `nsc ssh` runs outside the desktop session and has no screen or input permission, and macOS 26 also shows a "bypass the system private window picker" alert that waits for a click. On every Mac, proofbox therefore:

- runs desktop commands in the user's session (`sudo launchctl asuser 501 sudo -u runner …`),
- grants `kTCCServiceScreenCapture`, `kTCCServiceAccessibility`, and `kTCCServicePostEvent` to `/opt/namespace/vmguest` in the system TCC database (possible because SIP is off and sudo needs no password),
- writes an approval for `/opt/namespace/vmguest` in `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist` before the first capture.

This edits private macOS files on purpose, so it can break with a macOS update. `create` ends with a test screenshot and a 1-second test capture and fails clearly when either is blocked or an alert is on screen. Details: `docs/research/namespace-test.md`.
