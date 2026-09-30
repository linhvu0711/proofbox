# proofbox

proofbox is a CLI that lets any coding agent rent a disposable machine, run an app on it, drive its screen, and bring back proof videos and screenshots.

It only checks work. Writing code stays wherever the agent already works (ADR 0001). The Caller drives the Sandbox from outside, so no agent and no model key ever runs inside it (ADR 0002). Any harness, script, or person can use it.

Words are in `CONTEXT.md`. Decisions are in `docs/adr/`.

## What it does

- Creates a Linux or macOS Sandbox, and the Provider deletes it at its Deadline, even when the Caller crashes (ADR 0003).
- Uploads your Work folder (tracked and new files, minus git-ignored ones). The Sandbox never clones your repo and never gets a GitHub token (ADR 0005).
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

## Install

Needs Node 24 or later and pnpm. The `namespace` Provider needs a Namespace login: `proofbox auth login namespace` opens the Namespace login page in your browser and saves a 30-day login (add `--region eu` for Europe; the default is `us`). A token works too: `echo <token> | proofbox auth login namespace --token`, or `PROOFBOX_NAMESPACE_TOKEN`. `nsc` on PATH is still needed for SSH and Live view. The `docker` Provider needs Docker.

```sh
git clone https://github.com/linhvu0711/proofbox.git
cd proofbox
pnpm install
pnpm build
pnpm link --global
```

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

## Commands

| Command | What it does |
| --- | --- |
| `auth login <provider>` | Logs in to a Provider. Namespace opens its login page in the browser; `--token` reads a token from stdin; `--region us\|eu` sets where new Sandboxes go. |
| `auth status` | Shows each Provider's login: account, region, expiry, and where it comes from. |
| `auth logout <provider>` | Removes the saved login and lists the Sandboxes that still run. |
| `create --os linux\|macos` | Creates a Sandbox and prints its id. Flags: `--provider`, `--work <folder>`, `--setup <file>`, `--env-file <file>`, `--size 4x8`, `--idle 15m`, `--max-life 3h`, `--max-size 500MB` (the most the Work folder upload may send). |
| `upload <id> <folder>` | Sends the Work folder again. Only changed and new files go; deleted files are removed. `--max-size` as on `create`. |
| `exec <id> -- <command>...` | Runs a command and passes its exit code through unchanged. |
| `screenshot <id> --out <file>` | Saves a PNG of the screen. |
| `click <id> <x> <y>` | Clicks. `--button left\|middle\|right`. |
| `type <id> <text>` | Types text. |
| `key <id> <keys>` | Presses keys, for example `ctrl+s` or `Return`. |
| `scroll <id> <x> <y> <up\|down\|left\|right> [steps]` | Scrolls. |
| `drag <id> <x1> <y1> <x2> <y2>` | Drags. |
| `mark <id> <label>` | Sets a Step mark during a Recording. |
| `record start <id>` | Starts a Recording. |
| `record stop <id> --out <file>` | Builds the Proof video and a Proof screenshot per Step mark, and downloads them. `--max-size 10MB` sets the Size limit. |
| `record stop <id> --discard` | Ends a Recording with no Proof video, so a failed run never becomes proof (ADR 0013). |
| `live <id>` | Prints the address and password of a Live view, so a person can watch and control the screen. |
| `list [--json]` | Lists your Sandboxes. |
| `delete <id>` | Deletes a Sandbox. |

Pixel actions take `--pace human\|fast` (human by default) and `--screenshot <file>` to save the screen after the action.

A proofbox failure exits `125` with one plain line on stderr, for example `Sandbox ran out of memory (4x8). Try --size 8x16.`

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
pnpm test:namespace   # needs PROOFBOX_NAMESPACE_TOKEN and nsc on PATH; uses real Namespace minutes
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
