# Can proofbox own the Mac login password, and does a typed password pass a real dialog?

Date: 2026-10-02
For: #116 (the Caller gets the Mac login password)

One live Namespace Mac, `ns:us:4rrkhsqmgo2os`, macOS 26.3.1, made with `proofbox create --os macos` and deleted after the test.

## Findings

- The login password of `runner` is `runner`. `dscl . -authonly runner runner` passes, and `admin`, the empty string, and `proofbox` fail. No Namespace or GitHub runner doc names this password ([Namespace GitHub Actions](https://namespace.so/docs/solutions/github-actions), [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
- The Mac logs in by itself: `autoLoginUser` is `runner` in `/Library/Preferences/com.apple.loginwindow`, and `/etc/kcpassword` holds the password.
- The login keychain is `~/Library/Keychains/login.keychain-db`. It is on the search list only in the user session (`sudo launchctl asuser 501 sudo -u runner security list-keychains`), not over a plain `nsc ssh` login.
- Root cannot set a new password without the old one. `sudo -n dscl . -passwd /Users/runner proofbox` prints `Permission denied. Please enter user's old password:` and waits on stdin. With stdin closed it fails with `eDSAuthFailed` (exit 10). This is the 10-minute wait from clocktrace demo run 3.
- With the old and the new password, the change works: `dscl . -passwd /Users/runner runner proofbox` exits 0.
- The keychain does not follow a `dscl` change. `security set-keychain-password -o runner -p proofbox <login keychain>` changes it separately. After that, `unlock-keychain -p proofbox` passes and `-p runner` fails (exit 51). Apple: a keychain whose password differs from the login password does not unlock by itself ([Apple Support](https://support.apple.com/en-ca/guide/keychain-access/kyca2429/mac)).
- Auto-login does not follow either. `sysadminctl -autologin set -userName runner -password proofbox` logs `SACSetAutoLoginPassword error:22` and still exits 0, and `/etc/kcpassword` stays unchanged. Adding `-adminUser runner -adminPassword proofbox` gives the same result.
- A real dialog accepts a typed password. `osascript -e 'do shell script "id -un" with administrator privileges'` in the user session opened the "osascript wants to make changes" dialog with `runner` filled in and the password field in focus. `proofbox type <id> proofbox` and `proofbox key <id> Return` passed it, and the script ran as `root`. After that, writing and reading a keychain item showed no dialog.
