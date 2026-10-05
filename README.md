# proofbox

proofbox is a CLI that lets any coding agent rent a disposable machine, run an app on it, drive its screen, and bring back proof videos and screenshots.

It only checks work. Writing code stays wherever the agent already works (ADR 0001). The Caller drives the Sandbox from outside, so no agent and no model key ever runs inside it (ADR 0002). Any harness, script, or person can use it. A Sandbox made with `--harness` is the one exception: a Harness writes code inside it (ADR 0023). See Harness.

Words are in `CONTEXT.md`. Decisions are in `docs/adr/`.

## What it does

- Creates a Linux or macOS Sandbox, and the Provider deletes it at its Deadline, even when the Caller crashes (ADR 0003).
- Without `--harness`, uploads your Work folder (tracked and new files, minus git-ignored ones). The Sandbox never clones your repo and never gets a GitHub token (ADR 0005).
- Runs a Setup script, then sends Secrets from your env file after setup, so setup and Snapshots never hold them.
- Drives the screen at human pace: screenshot, click, type, key, scroll, drag.
- Records the desktop and builds a Proof video in the Sandbox: Still parts cut, click rings, step captions, under the Size limit (10 MB by default). It also saves a Proof screenshot at each Step mark (ADR 0006).
- Leaves nothing in your repo. Its own config lives in `~/.config/proofbox/` (ADR 0007).

## Providers

| OS | Provider | Notes |
| --- | --- | --- |
| Linux | `namespace` (default) | Base image in a container on a Namespace host. Snapshots are kept for 14 days after last use. |
| macOS | `namespace` (default) | A real Mac. The Setup script runs on every Mac. |
| Linux | `docker` | Local Docker, no cost. The proofbox CI tests use it. |

Windows is not supported.

To pick a Provider per OS, write `~/.config/proofbox/config`:

```json
{ "linux": "docker", "macos": "namespace" }
```

No file means `namespace` for both. `create --provider <name>` overrides it for one Sandbox.

## Inside a Sandbox

On macOS, the user is `runner`, and sudo needs no password. When a macOS dialog asks for a password (a permission, the Keychain, an installer), type the Login password `runner` with `proofbox type`, the way a person does (ADR 0020). `create` checks that the password still works and fails when it does not. System Events, Terminal, and Finder are already allowed for Apple Events. A command that controls another app (for example `osascript -e 'tell application "Safari" …'`) shows a "sshd-keygen-wrapper wants access to control" dialog once per app and waits about 2 minutes. Run it in the background (`proofbox exec "$id" -- sh -c '… &'`), take a `proofbox screenshot`, and click Allow. A Mac made by a proofbox from before this change cannot be used after you update: delete it and create a new one. A Keeper the old proofbox started keeps its Mac until the Mac is deleted.

On Linux, the user is `app`. It has no password and no sudo.

## Install

Needs Node 24.12 or later and pnpm.

```sh
git clone https://github.com/linhvu0711/proofbox.git
cd proofbox
pnpm install
pnpm build
pnpm link --global
```

Then, for the `namespace` Provider, log in first: `proofbox auth login namespace` opens the Namespace login page in your browser and saves a 30-day login (add `--region eu` for Europe; the default is `us`). A token works too: `echo <token> | proofbox auth login namespace --token`, or `PROOFBOX_NAMESPACE_TOKEN`. For CI, make that token while logged in with the browser: `proofbox auth token namespace --name ci --expires 30d` prints it once (at most `1y`). The `docker` Provider needs Docker.

## Example

Run this from your app's folder. The Setup script installs the app's dependencies, and the env file holds its Secrets. Keep both outside the repo (ADR 0007).

```sh
cd ~/code/my-app
id=$(proofbox create --os linux --work . --setup ~/proof/my-app/setup-linux.sh --env-file ~/proof/my-app/app.env)

proofbox exec "$id" -- npm run build
proofbox exec "$id" -- sh -c 'nohup npm start >/tmp/app.log 2>&1 &'
proofbox record start "$id"
proofbox mark "$id" "step 1: open the app"
proofbox click "$id" 640 360
proofbox mark "$id" "step 2: save the post"
proofbox type "$id" "Hello"
proofbox key "$id" ctrl+s
proofbox record stop "$id" --out ~/proof/my-app/proof.mp4   # also saves proof-1.png, proof-2.png there
proofbox delete "$id"
```

A Sandbox id has its Provider as a prefix and, for Namespace, its region, for example `ns:us:abc123`. stdout holds only the result (an id, paths, a list). Messages go to stderr.

## Harness

This section is `feat/harness` work: it is not in `main` yet. A Sandbox made without `--harness` stays verify-only, as above.

With `--harness`, proofbox installs a Harness in the Sandbox: Claude Code now, Codex later (#194). The Harness runs there with all permissions, writes code, commits, and pushes. The Caller still drives it from outside (ADR 0023, ADR 0024).

Save the logins once per laptop:

```sh
claude setup-token                                  # prints a Claude token
echo <token> | proofbox harness login claude
echo <token> | proofbox github login <owner>        # a fine-grained token for the repos the Harness may push to
```

A token that can push can usually merge too. Protect `main`, or your default branch, with a ruleset that needs a review.

Make the Harness profile once: `proofbox harness profile init claude` copies `CLAUDE.md`, `skills/`, and `agents/` into `~/.config/proofbox/harness/claude/`. Edit it for Sandboxes only.

The loop. Run it from your app's folder, on a branch that is on GitHub:

```sh
id=$(proofbox create --os linux --harness claude --work .)
proofbox harness prompt "$id" "Add a CSV export and commit it"
proofbox harness wait "$id"           # blocks until the Turn ends, then prints its end state
# check the result with exec, screenshot, and record, as in Example
proofbox harness prompt "$id" "The export drops the header row. Fix it and commit."
proofbox harness wait "$id"
proofbox delete "$id"
```

To end a Turn early, wait with a limit: `proofbox harness wait "$id" --timeout 10m` exits 124 with `still running` when the Turn is not done by then. Then run `proofbox harness stop "$id"`.

A Turn ends in one of these states. `harness wait` prints it on stdout and exits with its code:

| State | Exit | What to do |
| --- | --- | --- |
| `done`, then the Harness's last message | 0 | Check the work. |
| `failed: Harness login refused` | 21 | Run `harness login`, then make a new Sandbox. |
| `failed: usage limit`, with `resets:` when known | 22 | Wait for the reset, then send the next prompt. |
| `failed: Harness crashed` | 23 | Read the lines above, then send the next prompt. |
| `stopped` | 20 | `harness stop` ended the Turn. |
| `still running`, with the last activity | 124 | Only with `--timeout`. Wait again, or `harness stop`. |

What costs money while a Turn runs:

- The Sandbox bills its Provider for every minute it lives, also while the model thinks: about $1.20 to $1.80 for a 20-minute Turn on a Namespace Mac (ADR 0023). Docker costs nothing.
- The Harness login pays for the model. Claude usage counts against the account behind `claude setup-token`. A Codex API key bills OpenAI.
- `harness wait` keeps the Sandbox alive. When you are done, `harness stop` and `delete`.

To check that a new Harness version still works, run `pnpm test:harness` (see Develop).

## Commands

| Command | What it does |
| --- | --- |
| `auth login <provider>` | Logs in to a Provider. Namespace opens its login page in the browser; `--token` reads a token from stdin; `--region us\|eu` sets where new Sandboxes go. |
| `auth status` | Shows each Provider's login: account, region, expiry, and where it comes from. Then one line per saved GitHub owner and saved Harness login, with the Claude token's end date. |
| `auth logout <provider>` | Deletes the Sandboxes this machine started, prints their ids, then removes the saved login. Waits first for a create still running here. Sandboxes and Unfinished Sandboxes started elsewhere keep running, and logout names them. Exits 125 when a region could not be checked or a delete failed. |
| `auth token <provider>` | Makes a token for CI from the browser login and prints it once. Flags: `--name <name>`, `--expires 30d` (at most `1y`). |
| `github login <owner>` | Saves a fine-grained GitHub token for one owner (a user or an org), read from stdin, so a Harness can push and open pull requests. One token per owner; saving the same owner again replaces it. Then says to protect `main` with a ruleset that needs a review. |
| `harness login claude\|codex` | Saves a Harness login read from stdin, readable only by you, in `~/.config/proofbox/harness-logins.json`. `claude` takes a token from `claude setup-token`; `codex` takes an OpenAI API key. |
| `harness profile init claude\|codex` | Makes the Harness profile `~/.config/proofbox/harness/<name>/` and copies in what works anywhere: `CLAUDE.md`, `skills/`, and `agents/` from `~/.claude/`, or `AGENTS.md` and `skills/` from `~/.codex/`. A link is copied as the files it points to. A link that leads nowhere or loops is skipped and named. Settings, hooks, plugins, and MCP config stay out. Prints the folder. The profile is readable only by you. Names any part the laptop lacks. Refuses a profile that already exists. Edit the profile for Sandboxes only. |
| `harness log <id>` | Prints the latest Turn of a Harness Sandbox, one line per step with its time, and the end state last: `done`, `failed: …`, `stopped`, or `still running`. A long step is cut to one line with its size. Before any prompt it says `no turn has run yet`. `--follow` prints new steps as they come and exits 0 when the Turn ends, pushing the Deadline meanwhile. `--full` prints the Harness's own JSON lines unchanged. |
| `create --os linux\|macos` | Creates a Sandbox and prints its id. Flags: `--provider`, `--work <folder>`, `--setup <file>`, `--env-file <file>`, `--size 4x8`, `--idle 15m`, `--max-life 3h`, `--max-size 500MB` (the most the Work folder upload may send), `--harness claude` (the Work folder becomes this branch fetched from GitHub with your unpushed commits and uncommitted files on top; installs Claude Code, `git`, and `gh`; sends the Harness login, the GitHub login, and the Harness profile; needs `harness login claude` and `github login <owner>` first), `--harness-version <v>` (an older Claude Code). |
| `harness prompt <id> <prompt>` | Starts a Turn in a Sandbox made with `--harness` and returns at once. `--model <name>` picks the model. Refuses a prompt while a Turn runs. The next prompt goes on in the same Harness session. |
| `harness wait <id>` | Waits for the Turn to end and prints its end state on stdout. Safe to run again. Pushes the Deadline while it waits. `--timeout 10m` returns early with `still running` and the last activity. |
| `harness stop <id>` | Stops the running Turn. Then `harness wait` prints `stopped`. |
| `upload <id> <folder>` | Sends the Work folder again. Only changed and new files go; deleted files are removed. `--max-size` as on `create`. |
| `exec <id> -- <command>...` | Runs a command and passes its exit code through unchanged. A command that is not there exits `127`. `exec` has no time limit: a command can run, and stay quiet, as long as it needs. Ctrl-C stops a stuck one. |
| `screenshot <id> --out <file>` | Saves a PNG of the screen at the size the Caller clicks in: 1440 x 900 on Linux, 1280 x 800 on a Mac. A spot at x, y in the PNG is `click <id> x y`; `scroll` and `drag` take the same positions. |
| `click <id> <x> <y>` | Clicks. `--button left\|middle\|right`. |
| `type <id> <text>` | Types text. |
| `key <id> <keys>` | Presses keys, for example `ctrl+s` or `Return`. |
| `scroll <id> <x> <y> <up\|down\|left\|right> [steps]` | Scrolls. |
| `drag <id> <x1> <y1> <x2> <y2>` | Drags. |
| `mark <id> <label>` | Sets a Step mark during a Recording. |
| `mark <id> <label> --wait` | Sets a Wait mark: the Still part it falls in, or the next one in its step, keeps its "» N s later" label with the reason after it. It starts no step (ADR 0018). |
| `record start <id>` | Starts a Recording. |
| `record stop <id> --out <file>` | Builds the Proof video and a Proof screenshot per Step mark, and downloads them. Each Proof screenshot is at the size the Caller clicks in, as `screenshot` gives. `--max-size 10MB` sets the Size limit. |
| `record stop <id> --discard` | Ends a Recording with no Proof video, so a failed run never becomes proof (ADR 0013). |
| `live <id>` | Prints the address and password of a Live view, so a person can watch and control the screen. |
| `list [--json]` | Lists your Sandboxes. Names each Unfinished Sandbox on stderr, with the `delete` command for it. |
| `delete <id>` | Deletes a Sandbox. |

Pixel actions take `--pace human\|fast` (human by default) and `--screenshot <file>` to save the screen after the action, at the same size as `screenshot`.

A screenshot shows what the app draws, not what a field holds. Chromium can draw a ligature pair such as `//` or `::` wrong when a ligature font (JetBrains Mono, Fira Code) is used and the pair is typed at human pace: `https://x.com` shows as `https: /x.com` while the field holds the right text. Before you report a typing bug, check the value the app got (a saved row, the request, the DOM).

A proofbox failure exits `125` with one plain line on stderr, for example `Sandbox docker:abc123 is gone`. A screen command, `mark`, `record`, or a download that gets no answer gives up after 2 minutes plus its own pace or Recording time, and exits `125`; a screenshot or a download tries once more first. The Keeper writes one line per command to `<runtime folder>/<provider>-<name>.log` (`$TMPDIR/proofbox-<uid>/` unless `PROOFBOX_RUNTIME_DIR` is set): the program, bytes, exit code, time, and how it ended, never the arguments or the input. It keeps one older file, `.log.1`, and stays after `delete`. A command that ran out of memory exits `122` with `Sandbox ran out of memory (4x8). Try --size 8x16.`

On Namespace, a missing local OS record makes proofbox read the host's OS label before choosing its SSH route. If that lookup fails, the command exits `125` without opening a link, rather than guessing Linux. An existing local OS record needs no lookup.

## Safety

- A Sandbox is deleted by the Provider at its Deadline: 5 minutes idle on macOS, 15 on Linux, and never later than the Max life of 3 hours.
- User code can never read the Namespace workload token (ADR 0009). `create` checks this and refuses the Sandbox when the check fails.
- proofbox does not cap how many Sandboxes run at once. The Provider's limit does, and proofbox reports it in plain words (ADR 0008).

## Not in scope

Windows, mobile, the accessibility tree, and an MCP server.

## Develop

```sh
pnpm test             # fake Provider, no cloud
pnpm test:docker      # needs Docker
pnpm test:namespace   # needs PROOFBOX_NAMESPACE_TOKEN (make one with `proofbox auth token namespace --name dev --expires 1d`); uses real Namespace minutes
pnpm test:harness     # by hand: needs Docker and a Harness login; runs one real Turn per Harness and uses its tokens
pnpm lint && pnpm typecheck
```

Read `CODING_STANDARDS.md` before you change code.

<!-- embed-source:start -->
## Embedded library source

`repos/` holds a full copy of some dependencies' source, so coding agents can read the real implementation and tests instead of guessing from docs. `docs/idioms/` holds short notes that quote the idioms this project uses, with a path into `repos/` above each snippet. `CLAUDE.md` tells agents to start there.

| lib | version | fetched from |
| --- | --- | --- |
| effect | 3.22.2 | https://github.com/Effect-TS/effect.git at tag `effect@3.22.2` |

Rules:

- Never import from `repos/`. Import from the installed package.
- Never edit files under `repos/`. They are replaced wholesale on the next fetch.
- Lint, type-check, and tests skip `repos/`.

`repos/` is not in git. `pnpm install` runs `scripts/sync-repos.sh`, which reads the table in `repos/README.md` and does a shallow clone of each pinned tag. Run the script by hand if the folder is missing. Set `EMBED_SOURCE_SKIP=1` to skip the fetch.

After bumping a package, change its tag in `repos/README.md`, run `scripts/sync-repos.sh`, and change the version in this table, in the `CLAUDE.md` table, and in the first line of each `docs/idioms/effect-*.md` file.
<!-- embed-source:end -->
