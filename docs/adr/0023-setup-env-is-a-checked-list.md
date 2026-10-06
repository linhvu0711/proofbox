# The Setup env is a checked list, not a sourced script

The Linux Sandbox user has no sudo, so a Setup script installs its tools in a folder of its own, and every later `exec` needs that folder on its `PATH` (issue #236). The Setup script gets a file path in `$PROOFBOX_ENV`, the way GitHub Actions gives a step `$GITHUB_ENV`, and writes `NAME=value` lines into it, with the same rules as the Secrets file. When the Setup script ends, before any Snapshot is saved, proofbox reads the file once, keeps a clean copy in its state folder, and every later `exec` gets those values. A bad line fails `create` and names the line. A name that is in both the Setup env and the Secrets file also fails `create`, and the error names it.

## Considered options

- Let `exec` source the file as a shell script (`. "$PROOFBOX_ENV"`): rejected. A bad line or stray output would break every `exec` instead of failing one `create`. A value with a space would need shell quotes. Code the Caller wrote would also run before every command.
- Let a Secret win over a Setup env value with the same name: rejected. A clash is rare, since the Setup env holds tool settings and the Secrets file holds keys. When one happens, an error is better than one value silently hiding the other.
