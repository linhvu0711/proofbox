# Harness logins and GitHub logins enter the Sandbox

A Harness needs a model login, and it needs a GitHub login to push and open pull requests (ADR 0023). Both now enter a Sandbox, next to app code and packages from the internet, so we pick the logins whose damage stays small and that the Caller can revoke. The Provider login still never enters a Sandbox.

- Each Harness declares its machine login. Claude Code uses the one-year token from `claude setup-token`, which uses the Caller's subscription and which the Caller can delete in Claude under Settings → Claude Code. Codex uses a ChatGPT plan login: `proofbox harness login codex` runs `codex login --device-auth` with `CODEX_HOME` in a folder proofbox owns, so it is a login of its own, apart from the Caller's laptop login in `~/.codex/`, and a renewal on one side never breaks the other. A ChatGPT login is a file Codex renews (`auth.json`), so the Harness seam has two kinds of login: an env value and a file in the Harness home. proofbox keeps them in `~/.config/proofbox/`, readable only by the owner, and never touches the Caller's own laptop login of that Harness.
- The GitHub login is a fine-grained token that the Caller makes, for the repos they pick, with code and pull request rights and an expiry. A fine-grained token has one owner, so proofbox keeps one per owner and picks it from the repo's remote. It goes in as `GH_TOKEN`. A token that can write code can usually merge too, so proofbox tells the Caller to protect the default branch with a ruleset that needs a review.
- Both go in when `create --harness` makes the Sandbox, after any Snapshot is saved, the same way a Secret does, so no Snapshot ever holds them. A Harness profile goes in at the same time, because its MCP config can hold tokens.

Sources: Claude Code auth, https://code.claude.com/docs/en/iam; deleting the token, https://support.anthropic.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions; Codex auth, https://developers.openai.com/codex/auth; single-use Codex refresh tokens, https://github.com/openai/codex/issues/15410. Checked 2026-10-02. ChatGPT plan login for Codex, https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/docs/auth/ci-cd-auth, checked 2026-10-04.

Before create sends a Codex login, proofbox renews it when its last renewal (`last_refresh`) is older than 7 days, through `codex app-server` (`account/read` with `refreshToken`), and saves the renewed file. Codex renews by itself only near its access token's end or after a 401, so a Sandbox (3 hours at most) normally never renews.

When `harness wait` sees a Turn end, and on `delete`, proofbox reads the Sandbox's `auth.json` and keeps it when its last renewal is newer than the saved one, under the logins lock, so the newest refresh token wins when two Sandboxes end at once.

## Considered options

- Copy the Caller's laptop `~/.codex/auth.json`: rejected. Its refresh token works one time only, so when one copy renews, the Caller's laptop login and every other copy break.
- Codex with an API key (`CODEX_API_KEY`): rejected on 2026-10-04. Clear terms, but it bills per token instead of the Caller's ChatGPT plan.
- Copy the logins already on the laptop: rejected for the same reason, and because it reuses the Caller's personal login.
- API keys only, for every Harness: rejected. Clear terms, but much more expensive than a subscription.
- `gh auth token` from the laptop: rejected. It reaches every repo the Caller can reach, in every org, and does not expire.
- `gh auth login` with a device code in each Sandbox: rejected. The Caller opens a browser for each Sandbox, which breaks parallel work, and gets the same broad token.
- The Harness commits and the Caller pushes from the laptop, so no GitHub token goes in: rejected. The Caller wants the Harness to open pull requests by itself, the way a Devin handoff does.
