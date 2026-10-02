# A Caller passes macOS dialogs with Namespace's login password

macOS dialogs for permissions, the Keychain, and installers ask for the login password, and in clocktrace demo run 3 an agent that did not know it lost 10 minutes. proofbox keeps the password Namespace sets (`runner`), checks on create that the login and the login keychain both accept it, and documents it. A Caller types it into a dialog the way a person does. proofbox does not skip the dialog for the Caller's app.

## Considered options

- proofbox sets its own password on create: rejected. On macOS 26.3.1, root cannot set a new password without the old one (`dscl . -passwd` asks for it), so this depends on Namespace's `runner` just as much. It also needs a separate keychain change (`security set-keychain-password`), and auto-login keeps the old password because `sysadminctl -autologin set` fails with `error:22` while it exits 0. Tested on a live Namespace Mac on 2026-10-02.
- A new random password for each Sandbox: rejected. `runner` already has sudo with no password, so anyone who can run commands is root already. The login password gives no new power, and a random one only adds storage and output.
- Grant the Caller's app its permissions in the TCC database, as ADR 0012 does for proofbox's own tool: rejected. A real user sees the dialog, types the password, and turns on the switch. Skipping it hides that step from the Proof video and hides a broken permission flow in the app. It would also not cover Keychain or installer dialogs.

## Consequences

If Namespace changes the password, every Mac create fails at the password check until proofbox and the README are updated.
