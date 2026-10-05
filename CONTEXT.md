# proofbox

proofbox is a CLI that lets any coding agent rent a disposable machine, run an app on it, drive its screen, and bring back proof videos and screenshots. It can also run a Harness in a Sandbox, so code gets written there and the agent checks it there. ADR 0023 records that decision. Claude Code runs Turns; Codex comes with #194, and the README describes only checking work until #195.

## Language

### Machines

**Sandbox**:
A disposable machine (Linux or macOS in v1) that proofbox creates, drives, and deletes for one caller.
_Avoid_: VM, box, instance, devbox

**Unfinished Sandbox**:
A machine that `create` started at the Provider but has not finished making into a Sandbox. A create may still be making it, or a create stopped part way. It still counts against the Provider account's quota until `delete` removes it or its Deadline passes.
_Avoid_: half-made host, orphan, leftover instance

**Provider**:
A service that supplies Sandboxes, such as Namespace or Docker. Each OS maps to one Provider in the config.
_Avoid_: platform, backend, vendor

**Capability**:
One thing a Provider can or cannot do, such as an OS, Snapshots, or a Live view. proofbox refuses a request that needs a Capability the Provider lacks.
_Avoid_: feature, support flag

**Sandbox id**:
The name of a Sandbox, prefixed by its Provider and, for a Provider with regions, its region (`ns:us:abc123`), so every command knows where to go. Local state is never the source of truth.
_Avoid_: handle, session id

**Keeper**:
A background process on the Caller's machine that holds one open connection to one Sandbox, so each command takes well under a second. `create` starts it, any command restarts it if it is gone, and it stops when its Sandbox is gone. It never pushes the Deadline on a timer of its own: only a command pushes it. It only saves time: losing it changes nothing.
_Avoid_: daemon, agent, server, session

**Deadline**:
The Provider-side time at which a Sandbox is deleted. Each proofbox command pushes it ahead by the idle time (default 5 minutes on macOS, 15 on Linux, set by the Caller on create), never past the Max life.
_Avoid_: TTL, idle timer, timeout

**Max life**:
The hard limit on how long a Sandbox can live, 3 hours by default, however active it is.
_Avoid_: hard TTL, lease

**Login password**:
The password of the macOS Sandbox user `runner`, which is `runner`. A Caller types it into macOS dialogs (permissions, Keychain, installers) the way a person does. Namespace sets it, and proofbox only checks it on create. It is not a Secret. A Linux Sandbox has none: its user `app` has no password and no sudo.
_Avoid_: admin password, sudo password, user password

**Sandbox size**:
The CPU count and RAM of a Sandbox, written `4x8` (4 vCPU, 8 GB). Each Provider has a default per OS and an ordered list of bigger sizes. Not the Size limit, which is about the Proof video.
_Avoid_: machine type, shape, spec, instance size

### Accounts

**Provider account**:
The Caller's own account at a Provider, which owns and pays for its Sandboxes. proofbox has no account of its own.
_Avoid_: tenant, workspace, proofbox account

**Provider login**:
What proofbox keeps on the Caller's machine so it can act for one Provider account: a browser login or a token the Caller gave it. It is never a Secret and never enters a Sandbox.
_Avoid_: credential, auth, session, API key

**Harness login**:
The machine login of one Harness that proofbox keeps on the Caller's machine: a Claude Code `setup-token` or a Codex API key. It goes into a Sandbox made with `--harness`, after any Snapshot is saved, the same way a Secret does, so no Snapshot holds it. Not the Caller's own laptop login of that Harness, which proofbox never touches.
_Avoid_: model key, credential, auth file

**GitHub login**:
A fine-grained GitHub token for one owner (a user or an org) that the Caller makes and proofbox keeps. It goes into a Sandbox made with `--harness` as `GH_TOKEN`, after any Snapshot is saved, so the Harness can push and open pull requests; create also uses it to fetch the branch, without writing it to disk.
_Avoid_: gh token, PAT, GitHub credential

### Getting the app ready

**Work folder**:
The caller's folder as uploaded into the Sandbox: tracked files plus new files, minus git-ignored ones. In a Sandbox with a Harness, it is instead the Caller's branch cloned from GitHub, with the Caller's unpushed commits and uncommitted files put on top.
_Avoid_: checkout, clone, repo copy

**Setup script**:
A per-OS script the Caller passes on create that installs the app's dependencies, not the app build itself. It lives wherever the Caller keeps it, never required inside the repo, and it never sees Secrets.
_Avoid_: bootstrap, install script, environment file

**Base image**:
The proofbox-owned starting point for a Sandbox: a desktop, a browser, fonts, and the recording tools. On Namespace a Base image version is deleted after 14 days without use; a Sandbox started from it, or from a Snapshot made from it, is a use.
_Avoid_: template, golden image

**Tool bundle**:
The pinned set of proofbox's own tools a Sandbox needs (ffmpeg, the input helper), each with a fixed hash. The core defines it; each Provider decides how it gets into a Sandbox: inside the Base image for Docker, through Namespace's download cache on Namespace macOS.
_Avoid_: dependencies, toolchain, runtime

**Snapshot**:
A saved Sandbox made from the Base image plus a finished Setup script, found again by its Fingerprint, and deleted after 14 days without use. A Provider without Snapshots runs the Setup script on every Sandbox.
_Avoid_: image, template, warm pool, cache

**Fingerprint**:
The hash of the Base image version, the Setup script, and the Work folder's lockfiles that names a Snapshot. Same Fingerprint means the Snapshot is reused.
_Avoid_: cache key, digest, tag

**Secret**:
An env value from the env file the Caller passes on create. It lives only on the Caller's machine until proofbox sends it into one Sandbox, after the Setup script has finished and any Snapshot is saved, so neither ever holds it.
_Avoid_: credential, env var

### Driving and watching

**Caller**:
Whoever runs proofbox commands: a main agent, a helper agent, a script, or a person. A Caller can itself be a coding CLI on a laptop; it is still the Caller, not a Harness.
_Avoid_: brain, harness, driver, client

### Writing code in a Sandbox

**Harness**:
A coding CLI, such as Claude Code or Codex, that proofbox installs at its newest version and runs inside a Sandbox with all permissions, so it writes, commits, and pushes code there. Each one fits the same Harness seam, the way each Provider fits the Provider seam. Claude Code is built; Codex is not yet (#194).
_Avoid_: inner agent, coding agent, worker, bot

**Harness session**:
The one conversation a Harness keeps in a Sandbox across Turns. A Sandbox has at most one, so the Sandbox id names it.
_Avoid_: thread, chat, session id

**Turn**:
One run of the Harness, from a prompt the Caller sends until the Harness ends it: done, failed, or stopped. A Sandbox runs one Turn at a time, and proofbox refuses a prompt while one runs.
_Avoid_: run, task, job, step

**Harness step**:
One thing a Harness did in a Turn: a message, a tool call with its main input, or what a tool gave back. `harness log` prints one line per Harness step.
_Avoid_: event, activity, Step mark

**Harness profile**:
A folder per Harness that the Caller owns on their machine, shaped like that Harness's home folder (for Claude Code, `~/.claude/`): global instructions, skills, subagents, and MCP servers meant for a Sandbox. proofbox copies it into a Sandbox after any Snapshot is saved. It is not the Caller's laptop config, which proofbox reads only once, to fill a new profile. It lives in `~/.config/proofbox/harness/<name>/`, and `proofbox harness profile init <name>` makes it.
_Avoid_: config, dotfiles, settings

**Pixel action**:
A screen command that works the way a person does: screenshot, click, type, key, scroll, drag.
_Avoid_: computer use, GUI action, input event

**Live view**:
A remote screen of a Sandbox that a person opens to watch, click, and type.
_Avoid_: stream, preview, VNC (the protocol, not the thing)

**End line**:
The last line a Sandbox writes after each command's own output: its exit code, how many bytes of output it made, and the memory-kill counts. The Keeper takes it out before the Caller sees the output, and a command ends when its End line and all its output have arrived. Not built yet: until #118 ships, the End line holds only the memory-kill counts and a command ends at the ssh exit.
_Avoid_: trailer, checks trailer, last line

### Proof

**Recording**:
The raw, full-quality capture of a Sandbox desktop between `record start` and `record stop`.
_Avoid_: video (too loose), screencast

**Action log**:
The timed list of commands, Step marks, and Wait marks during a Recording, kept inside the Sandbox next to it.
_Avoid_: trace, event log

**Keeper log**:
The file on the Caller's machine where the Keeper writes one line per request: the program, how long it took, and how it ended, never the arguments, the input, or the output.
_Avoid_: trace, debug log

**Step mark**:
A label the Caller sets during a Recording ("step 3: save the post"). It becomes the caption on the Proof video and the anchor for a Proof screenshot.
_Avoid_: chapter, annotation

**Wait mark**:
A reason the Caller gives for a Still part during a Recording ("waiting for the scheduler"). That Still part keeps its label, with the reason after it. It does not start a step.
_Avoid_: wait step, pause

**Still part**:
A stretch of a Recording where nothing on screen changes. The Proof video cuts it. It keeps a short "» 1 min 50 s later" label only when the app ended it or a Wait mark names it.
_Avoid_: idle time, dead time, thinking time

**Proof video**:
The final MP4 made from a Recording: Still parts cut, actions at real speed, Step mark captions, under the Size limit.
_Avoid_: demo, recording, walkthrough video

**Proof screenshot**:
A PNG of the screen taken at a Step mark, at the size the Caller clicks in.
_Avoid_: capture, snap

**Size limit**:
The largest Proof video proofbox may produce, 10 MB by default to fit the GitHub free-plan attachment limit.
_Avoid_: quota, cap
