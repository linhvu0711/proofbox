# `auth logout` deletes the Sandboxes this machine started

On Namespace, the host's own Deadline drifts: every ssh session through the gateway pushes it a few minutes out. So a detached expire process on the Caller's machine destroys the host at the Sandbox's Deadline or Max life, and it needs the Provider login to do that. Once `auth logout` removes the login, that process cannot destroy anything, and a Mac can run on at about $3.60 to $5.40 an hour (ADR 0003). That is why `auth logout` first deletes every Sandbox this machine started, then removes the login. It does this every time, with no prompt and no flag, because agents and CI run it with no one at the keyboard.

"Started on this machine" means the Sandbox has local files under the Keeper dir. `list` returns every proofbox Sandbox in the Provider account, CI's included, but a Sandbox started elsewhere has its expire process on that machine, with that machine's login. Logout leaves those alone and names them as still running, started elsewhere.

The login always goes, even when a region cannot be checked or a delete fails, so the Caller can always remove their credentials: offline, on a lost laptop, or with an expired login. In that case logout stops the local Keepers, so no ssh session keeps a host alive, names each failure, and exits 125, like any proofbox failure. A missed host then stops at its own Deadline a few minutes later.

A create still running on this machine counts as started here. Its host exists before its local files do, and its Namespace API calls read the login on every call, so a logout in the middle would leave a host with no login to stop it. Each create with a Provider login leaves a create mark in the Keeper dir, named by its process id, until its Max life file is written, and touches the mark every ten seconds. Logout waits for every mark whose process is alive and that was touched in the last minute, with no time limit, then deletes those Sandboxes with the rest. A crashed create's mark goes stale, even when its process id is reused. A create ends on its own, so logout cannot hang forever. A fixed limit would cut off a slow but healthy Mac create and bring the bug back. Create writes its mark under the logins lock before the Provider reads the login, and logout takes its last look for marks and removes the login under that same lock, so a create either shows up for logout or finds no login and makes nothing.

## Considered options

- A credential that outlives the login, kept for the expire process: a full-power token stays on disk after the Caller logged out.
- Only change the message to say Sandboxes may run past their Deadline: a paid Mac keeps running, which breaks ADR 0003.
- Ask before deleting, or a `--keep` flag: a prompt blocks agents and CI, and a kept host has no login left to stop it.
- Refuse to log out while a delete fails: with no network or an expired login, the Caller could never log out.
- Delete every Sandbox in the account: logout on a laptop would kill a CI run.
- The create backs out on its own: it keeps its login in memory and destroys its own host when it sees the login gone. Every Namespace API call reads the login fresh, so each one would need to change.
- One runtime-dir lock that each create holds for its whole make: two creates could not run at the same time, and agents run them side by side.
