# Create has a time limit for each part it owns

On Namespace, `create` asks Namespace for a machine, prepares the host, and then hands it the user's work. Asking for the machine has a 60 s limit (`PROOFBOX_NS_CREATE_TIMEOUT`). Preparing the host has one 15 min limit for the whole part (`PROOFBOX_NS_PREPARE_TIMEOUT`). That part covers sshd, the Snapshot or Base image, the container, and the token check. When the limit runs out, `create` names the step it was in and deletes the host. Every request to the Namespace API has a 30 s limit. The one exception is the wait for the machine, which the 60 s limit covers.

The Work folder upload, the Setup script, and the Secrets get no new limit. The Setup script is the user's own code and can run long, as `exec` can (ADR 0019).

In a build run on 2026-11-18, one `create` sat in host preparation for 90 min and kept the host alive the whole time (#261).

## Considered options

- A limit on each host command: rejected. Each new command needs its own number, and a command that has none hangs again.
- One limit for all of `create`: rejected. A stuck Namespace would take 15 min to report, not 60 s, and a long Setup script would be cut.
- A limit on the Setup script: rejected. A slow `npm install` is not a stuck one.
