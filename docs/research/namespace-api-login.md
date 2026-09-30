# Can proofbox drive Namespace and log users in without `nsc`?

Date: 2026-09-29
For: Provider login grill (ADR 0014)

## Findings

### API and SDK

- Namespace publishes Compute and IAM APIs as gRPC/HTTP, with protos in the Buf module `buf.build/namespace/cloud`. Compute is regional at `https://{region}.compute.namespaceapis.com`; IAM is `https://iam.namespaceapis.com`. Source: https://pkg.go.dev/namespacelabs.dev/integrations/proto/namespace/cloud/compute/v1beta, https://buf.build/namespace/cloud/docs/main:namespace.cloud.iam.v1beta.
- The official TypeScript SDK is `@namespacelabs/sdk` (v1.0 announced 2026-08-27). Source: https://github.com/namespacelabs/typescript-sdk, https://namespace.so/changelog.
- The SDK's compute client defaults to region `us` and takes a `region` or `baseUrl` override. Source: https://github.com/namespacelabs/typescript-sdk/blob/main/src/api/compute/client.ts.
- The SDK reads existing credentials only (`loadUserToken()`, `fromBearerToken()`, `loadDefaults()`); it has no login. Source: https://github.com/namespacelabs/typescript-sdk.

### Each Caller-side `nsc` call and its API equivalent

- `nsc create` → `ComputeService.CreateInstance` (`shape.virtual_cpu`, `shape.memory_megabytes`, `shape.os` `linux`/`macos`, `shape.machine_arch`, `deadline`, `labels`, `experimental.authorized_ssh_keys`). Source: Compute API reference above.
- `nsc destroy` → `ComputeService.DestroyInstance`. Source: same.
- `nsc extend --ensure_minimum` → `ComputeService.ExtendInstance({ instance_id, ensure_minimum })`. Source: same.
- `nsc list --label` → `ComputeService.ListInstances({ label_filter })`, paginated. Source: same.
- `nsc instance port-forward` (port 22) → `ComputeService.GetSSHConfig` returns endpoint, username, a per-instance private key, and host keys. Native SSH is `ssh <instanceid>@ssh.<region>.namespace.so`. Source: same, and https://namespace.so/changelog.
- `nsc instance port-forward` (port 5900) → `ComputeService.GetVNCConfig` returns endpoint, username, password. Source: Compute API reference above.
- `nsc registry update-image-expiration` → the public Container Registry API (a global API in the SDK). Images never expire unless an expiry or a policy is set. Source: https://namespace.so/docs/solutions/docker-builders/registry, https://github.com/namespacelabs/typescript-sdk.

### Login

- `nsc login` calls `StartLogin` (returns `login_id`, `login_url`), opens the URL in a browser (or prints it), then calls `CompleteTenantLogin(login_id)`, which returns a `session_token` (30 days by default) or a `tenant_token`. There is no OAuth client id in the request. Source: https://github.com/namespacelabs/foundation/blob/main/internal/cli/cmd/auth/login.go.
- `token.json` holds `bearer_token` and/or `session_token`, mode 0600. Source: https://github.com/namespacelabs/foundation/blob/main/internal/auth/tokens.go.
- A session token is traded for a tenant token (at most 1 hour, cached) with `UserSessionsService.IssueTenantTokenFromSession`. The Compute API takes the tenant token as Bearer. Source: https://github.com/namespacelabs/integrations/blob/main/auth/token.go.
- `IssueTenantTokenFromSession` and the `StartLogin` calls are not in the public IAM protos. Source: https://buf.build/namespace/cloud/docs/main:namespace.cloud.iam.v1beta.
- `TokenService.CreateRevokableToken` is public: `name`, `expires_at` (up to 1 year), `access.grants`; `nsc token create` sends no `policies` and Namespace accepts that (probe 2026-09-30, foundation `internal/cli/cmd/token/token.go:149-164`). The caller needs the `token/revokable` `create` permission.
- Revokable tokens are made with `nsc token create`; the dashboard API Tokens page lists and revokes them but has no create button (seen by the user on 2026-09-29). Source: https://namespace.so/changelog.
- `StartLogin`, `CompleteTenantLogin`, and `IssueTenantTokenFromSession` are JSON POSTs to `https://private-api.global.namespaceapis.com/nsl.signin.SigninService/<Method>`; `CompleteTenantLogin` is one call that Namespace holds until the browser click and answers with a one-item JSON array (`nsc` makes one call and no loop). Source: foundation `internal/fnapi/signin.go:49-96`, `internal/cli/cmd/auth/login.go:43-57`.
- Namespace gives no region at login: neither the `st_` session nor the `nsct_` tenant token has a region claim, and one tenant token works at both `us` and `eu` (probe 2026-09-30). `nsc` reads `workload_region`/`primary_region` claims when a token has them (foundation `internal/auth/tokens.go:95`).

### Devin and Cursor

- Devin Outposts (2026-07-21) run Devin sessions on Namespace Devboxes; the user clicks "Connect with Devin" in Namespace, and Devin holds a Devin token, not a Namespace token. Source: https://docs.devin.ai, https://namespace.so/changelog.
- Cursor Cloud Agents on Namespace (2026-09-02): the user pastes a Cursor service-account key into a Namespace Devbox Blueprint. Cursor holds no Namespace token. Source: https://docs.cursor.com, https://namespace.so/changelog.

## Open

- The exact Registry API method name for image expiry. The Buf page did not load; read the SDK's registry client.
- Whether Namespace allows outside tools to use the private login calls. Not asked, by choice (ADR 0014).
