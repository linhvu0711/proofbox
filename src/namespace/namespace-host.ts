import type { Effect } from "effect";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import type {
  Os,
  SandboxCallError,
  SandboxInfo,
  SandboxRef,
} from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import type { Link } from "./ssh-link.ts";

// What the Namespace Provider asks of one host's OS. The Provider keeps the
// Namespace API calls, list, and the create flow once; a Linux host and a
// Mac host each do the steps that differ by OS.
export interface NamespaceHost {
  readonly os: Os;
  // Reads the Sandbox over the host's link.
  readonly read: (
    link: Link,
    ref: SandboxRef,
  ) => Effect.Effect<SandboxInfo, SandboxCallError>;
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
