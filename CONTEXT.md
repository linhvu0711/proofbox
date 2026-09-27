# proofbox

proofbox is a CLI that lets any coding agent rent a disposable machine, run an app on it, drive its screen, and bring back proof videos and screenshots. It covers verification only; writing code stays wherever the agent already works.

## Language

### Machines

**Sandbox**:
A disposable machine (Linux or macOS in v1) that proofbox creates, drives, and deletes for one caller.
_Avoid_: VM, box, instance, devbox

**Provider**:
A service that supplies Sandboxes, such as Namespace or Docker. Each OS maps to one Provider in the config.
_Avoid_: platform, backend, vendor

**Capability**:
One thing a Provider can or cannot do, such as an OS, Snapshots, or a Live view. proofbox refuses a request that needs a Capability the Provider lacks.
_Avoid_: feature, support flag

**Sandbox id**:
The name of a Sandbox, prefixed by its Provider (`ns:abc123`), so every command knows where to go. Local state is never the source of truth.
_Avoid_: handle, session id

**Keeper**:
A background process on the Caller's machine that holds one open connection to one Sandbox, so each command takes well under a second. `create` starts it, any command restarts it if it is gone, and it stops when its Sandbox is gone. It only saves time: losing it changes nothing.
_Avoid_: daemon, agent, server, session

**Deadline**:
The Provider-side time at which a Sandbox is deleted. Each proofbox command pushes it ahead by the idle time (default 5 minutes on macOS, 15 on Linux, set by the Caller on create), never past the Max life.
_Avoid_: TTL, idle timer, timeout

**Max life**:
The hard limit on how long a Sandbox can live, 3 hours by default, however active it is.
_Avoid_: hard TTL, lease

### Getting the app ready

**Work folder**:
The caller's folder as uploaded into the Sandbox: tracked files plus new files, minus git-ignored ones.
_Avoid_: checkout, clone, repo copy

**Setup script**:
A per-OS script the Caller passes on create that installs the app's dependencies, not the app build itself. It lives wherever the Caller keeps it, never required inside the repo, and it never sees Secrets.
_Avoid_: bootstrap, install script, environment file

**Base image**:
The proofbox-owned starting point for a Sandbox: a desktop, a browser, fonts, and the recording tools.
_Avoid_: template, golden image

**Tool bundle**:
The pinned set of proofbox's own tools a Sandbox needs (ffmpeg, the input helper), each with a fixed hash. The core defines it; each Provider decides how it gets into a Sandbox: inside the Base image for Docker, through Namespace's download cache on Namespace macOS.
_Avoid_: dependencies, toolchain, runtime

**Snapshot**:
A saved Sandbox made from the Base image plus a finished Setup script, found again by its Fingerprint. A Provider without Snapshots runs the Setup script on every Sandbox.
_Avoid_: image, template, warm pool, cache

**Fingerprint**:
The hash of the Base image version, the Setup script, and the Work folder's lockfiles that names a Snapshot. Same Fingerprint means the Snapshot is reused.
_Avoid_: cache key, digest, tag

**Secret**:
An env value from the env file the Caller passes on create. It lives only on the Caller's machine until proofbox sends it into one Sandbox, after the Setup script has finished and any Snapshot is saved, so neither ever holds it.
_Avoid_: credential, env var

### Driving and watching

**Caller**:
Whoever runs proofbox commands: a main agent, a helper agent, a script, or a person.
_Avoid_: brain, harness, driver, client

**Pixel action**:
A screen command that works the way a person does: screenshot, click, type, key, scroll, drag.
_Avoid_: computer use, GUI action, input event

**Live view**:
A remote screen of a Sandbox that a person opens to watch, click, and type.
_Avoid_: stream, preview, VNC (the protocol, not the thing)

### Proof

**Recording**:
The raw, full-quality capture of a Sandbox desktop between `record start` and `record stop`.
_Avoid_: video (too loose), screencast

**Action log**:
The timed list of commands and Step marks during a Recording, kept inside the Sandbox next to it.
_Avoid_: trace, event log

**Step mark**:
A label the Caller sets during a Recording ("step 3: save the post"). It becomes the caption on the Proof video and the anchor for a Proof screenshot.
_Avoid_: chapter, annotation

**Still part**:
A stretch of a Recording where nothing on screen changes. The Proof video replaces it with a short "⏩ 1 min 50 s later" label.
_Avoid_: idle time, dead time, thinking time

**Proof video**:
The final MP4 made from a Recording: Still parts cut, actions at real speed, Step mark captions, under the Size limit.
_Avoid_: demo, recording, walkthrough video

**Proof screenshot**:
A full-size PNG taken at a Step mark.
_Avoid_: capture, snap

**Size limit**:
The largest Proof video proofbox may produce, 10 MB by default to fit the GitHub free-plan attachment limit.
_Avoid_: quota, cap
