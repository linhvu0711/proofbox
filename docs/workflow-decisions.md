# Workflow decisions

Settled 2026-09-27 in the workflow grill: how `/ship`, `/implement`, and `/land-pr` use proofbox. Terms are in `CONTEXT.md` under Workflow.

## Where things run

1. Every project is built in worktrees on the Mac, as today. The VPS is out of scope: local builds have not been a bottleneck yet. Only checking moves off the Mac.
2. `/ship` says what runs where in its first line and its report, for example `Build: Mac · Check: Namespace macOS`.
3. Linux checks run on Namespace, not in Docker on the Mac, so the Mac's RAM stays free. The Docker provider stays for proofbox's own CI tests.
4. The report shows each check's time and cost, for example `Check: Namespace macOS · 12 min · about $0.72`.

## Skills

5. A new public skill, `/implement`, in `linhvu0711/skills`: it takes a `/plan-up` plan and delivers READY PRs (worktree, code, tests, Walks through proofbox, proof in the PR, `/land-pr`). It works on its own after `/plan-up`.
6. `/ship` keeps what is not building: `/plan-up` without its wait, the route (`/implement` by default, `via devin` or `via cursor`), the cloud path through the handoff skills, the report, and `/ship <note>` follow-ups. `/implement` takes the worktree, the build prompt, the builder, the Walks, the PR, and `/land-pr`. The build steps live only in `/implement`.
7. The builder: on Fable inside herdr, a Claude Code pane (Opus 5.5, 1M context, medium effort) runs `/implement` from start to end, Walkers included; the Fable session plans, starts the pane, answers its questions through `herdr-send`, and reports. On any other model, the session runs `/implement` itself. The Devin CLI pane is dropped, and the pane script moves from `ship/scripts/pane.sh` into `/implement`. The exact `claude` flags for 1M context and medium effort are checked when it is built.
8. `/implement` builds stacks from the start: layers one after another, each on its own branch on top of the last, each with its own Walks and PR.
9. The Devin and Cursor routes stay in `/ship` for now. `/implement` is the default, and `via devin` or `via cursor` forces the old route for one run. The user decides later when to remove them.
10. `/plan-up` does not change. `/implement` reads the plan's `UI walks` and `Videos` blocks as they are: each video step is a Step mark, and each `Shows` step's screenshot is the Proof screenshot at that mark.

## Walks

11. A Walker (helper agent, Opus 5.5) does each Walk, so the main agent's context stays on the code.
12. One Sandbox per plan. Its Walks run one after another, so setup is paid once and Walks can build on each other's data.
13. Every Walk is recorded. A failed one is discarded (`record stop --discard`); the first one that passes becomes the proof. No separate recording pass.
14. The caption bar is drawn by proofbox above the picture (the video grows taller), so it hides nothing, for web pages and Mac apps alike. It replaces the browser-only `document.body.style.paddingTop` trick in `handoff/rules.md`.
15. After a review fix, `/land-pr` walks again only the Walks whose code the fix touched, in a new Sandbox, and replaces their videos and screenshots in the PR body.

## When a Walk fails

16. The Walker returns the failed step, its screenshot, and the app logs. The main agent sorts it:
    - an app bug: fix, send the changes, walk again;
    - the plan does not match the app: a small fork is answered from the repo, a big fork goes to the user, as in `/plan-up` step 5;
    - proofbox or Namespace broke (after proofbox's own retries): tell the user.

    No fixed loop count. The loop stops and asks the user when the same failure comes back and no new cause is found.
17. Other unhappy cases:
    - no Project config yet: `/implement` drafts it (OS from the repo, a Setup script from the lockfiles), shows it, and asks for the env file path once. It never writes a secret;
    - the Setup script fails in the Sandbox: the agent fixes the script and shows the change in the report;
    - Mac limit reached: wait, and tell the user once that it is waiting;
    - the Sandbox runs out of memory: create it again one Sandbox size up (proofbox names the next size), save that size in the Project config so the next run starts there, and show it in the report, for example `Size: Linux 8x16 (raised from 4x8, out of memory)`. No question to the user. Out of memory at the largest size: stop and ask, since the app is the likely cause;
    - Namespace down or the account suspended: stop, tell the user, and suggest `via devin`;
    - the Proof video is still over 10 MB after proofbox lowers the quality: stop and ask;
    - `gh pr edit --attach` fails: the user pastes the files into the PR by hand, as today.

## Out of scope

- The VPS as a build or check machine.
- Removing the Devin and Cursor routes, and cancelling the subscriptions (the user's call, later).
- Parallel Walks inside one plan.
- Windows, mobile, the accessibility tree, and an MCP server for proofbox.

## Build order

1. proofbox core: CLI, Provider interface, fake and Docker providers (CI), Sandbox id, Deadline, Keeper, exec, upload and sync, Pixel actions at human pace, screenshots.
2. Recording and the Proof video: Still part cut, holds, click rings, caption bar above the picture, Size limit, discard. Needs 1.
3. Namespace Linux: container on a bare host, token isolation, Snapshots in the registry with a 14-day expiry, Live view. Needs 1.
4. Namespace macOS: prepare step, Tool bundle, RAM disk Secrets, test capture. Needs 1.
5. Walker and `/implement` for one PR: Project config, one Sandbox per plan, record every Walk, failure sorting, report with cost. Needs 2 and 3 (perch); 4 for clocktrace.
6. `/implement` stacks and `/land-pr` re-walks. Needs 5.
7. `/ship` on `/implement` with `via devin` and `via cursor`, and the Claude Code pane in place of the Devin CLI pane. Needs 6.

3 and 4 can run side by side.
