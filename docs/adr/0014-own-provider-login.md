# proofbox holds its own Provider login and talks to Namespace through its API

The Caller logs in to their own Provider account with `proofbox auth login <provider>`, and proofbox keeps that Provider login in `~/.config/proofbox/logins.json`, readable only by its owner. proofbox has no account or server of its own, so each Caller pays their Provider directly and proofbox never holds other people's machines. For Namespace, proofbox calls the public Compute, IAM, and Registry APIs through `@namespacelabs/sdk`, so the Caller's machine needs no `nsc`.

Namespace has no public login for outside apps. The browser login uses two private calls that `nsc login` uses (`StartLogin` / `CompleteTenantLogin`, and `IssueTenantTokenFromSession` to trade the 30-day session for short tenant tokens). They live in one file, so a change on Namespace's side is a one-file fix. We chose not to ask Namespace before building it. If those calls break, the token way still works: `PROOFBOX_NAMESPACE_TOKEN`, made with `proofbox auth token namespace` (the public `CreateRevokableToken` call) while the browser login still worked, or with `nsc token create`.

The Provider login holds the region new Sandboxes go to, but a Sandbox id carries its own region (`ns:us:abc123`), because each Namespace region sees only its own instances. A later login with another region still reaches older Sandboxes.

`auth logout` always removes the Provider login. It names the Sandboxes that still run, and when it cannot reach the Provider (no network, expired login) it says it could not check. Sandboxes left behind stop at their Deadline (ADR 0003).

Each Provider declares its login ways (browser, token, or none), so a Provider with a token page in its dashboard, a device-code login, or no login at all fits the same `auth` commands.

Sources: the login flow is in https://github.com/namespacelabs/foundation/blob/main/internal/cli/cmd/auth/login.go and https://github.com/namespacelabs/integrations/blob/main/auth/token.go; the public APIs are at https://buf.build/namespace/cloud.

## Considered options

- A proofbox account on a proofbox server that holds the Provider accounts: one login for every Provider, but it means running a server, billing, and abuse control.
- Token only, pasted by the Caller: all public calls, but Namespace makes tokens only with `nsc token create` today, so the Caller would still install `nsc`.
- Keep `nsc` as a second path: two code paths for the same Provider.
- Do what Devin and Cursor do: both are Namespace partners, and the link goes the other way (the Namespace machine calls them with their own key). Neither logs in to a Namespace account from outside.
