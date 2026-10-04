import type { Effect, Scope } from "effect";
import type { ChecksShell, Transport } from "../command-checks.ts";
import {
  ProviderError,
  type ProviderUnavailableError,
  SandboxGoneError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import type {
  Os,
  SandboxCallError,
  SandboxInfo,
  SandboxRef,
} from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import type { HostResult, Link, LinkVia } from "./ssh-link.ts";

// What the Namespace Provider asks of one host's OS. The Provider keeps the
// Namespace API calls, list, and the create flow once; a Linux host and a
// Mac host each do the steps that differ by OS.
export interface NamespaceHost {
  readonly os: Os;
  // The route every link after create takes to the host.
  readonly via: LinkVia;
  // Fails when this machine cannot reach the host over `via`.
  readonly reach: (
    ref: SandboxRef,
    paths: KeeperPaths,
  ) => Effect.Effect<void, ProviderUnavailableError>;
  // Reads the Sandbox over the host's link.
  readonly read: (
    link: Link,
    ref: SandboxRef,
  ) => Effect.Effect<SandboxInfo, SandboxCallError>;
  // Sets the Sandbox's Deadline `seconds` from the host's own clock.
  readonly writeDeadline: (
    link: Link,
    ref: SandboxRef,
    seconds: number,
  ) => Effect.Effect<HostResult, ProviderError | ProviderUnavailableError>;
  // The shell the command run's checks are written in (ADR 0015).
  readonly checks: ChecksShell;
  // How one argv reaches the Sandbox over the host's link.
  readonly call: (link: Link, ref: SandboxRef) => Transport["call"];
  // Sets up VNC for one Live view and gives its password. Scoped: the
  // view's finalizer runs when the scope closes.
  readonly livePassword: (
    link: Link,
    ref: SandboxRef,
  ) => Effect.Effect<
    string,
    ProviderError | ProviderUnavailableError,
    Scope.Scope
  >;
}

export const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

export const sandboxId = (ref: SandboxRef) =>
  formatSandboxId({ provider: "ns", region: ref.region, name: ref.name });

// `unfinished`: the host is there, but create never made its Sandbox.
export const gone = (ref: SandboxRef, unfinished?: true) =>
  new SandboxGoneError({ id: sandboxId(ref), unfinished });

export const brandFor = (ref: SandboxRef) => ({
  provider: "namespace",
  id: () => sandboxId(ref),
});
