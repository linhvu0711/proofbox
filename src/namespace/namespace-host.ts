import type { FileSystem } from "@effect/platform";
import { Effect, type Scope } from "effect";
import type { ChecksShell, Transport } from "../command-checks.ts";
import {
  ProviderError,
  type ProviderUnavailableError,
  platformReason,
  SandboxGoneError,
} from "../errors.ts";
import type { KeeperPaths } from "../keeper/paths.ts";
import type { Progress } from "../progress.ts";
import type {
  Os,
  OsOffer,
  Provider,
  SandboxCallError,
  SandboxFolders,
  SandboxInfo,
  SandboxRef,
} from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { shellJoin } from "../shell.ts";
import type { Size } from "../size.ts";
import type { HostResult, Link } from "./ssh-link.ts";

// What the Namespace Provider asks of one host's OS. The Provider keeps the
// Namespace API calls, list, and the create flow once; a Linux host and a
// Mac host each do the steps that differ by OS.
export interface NamespaceHost {
  readonly os: Os;
  // The user the host's own sshd logs in as (ADR 0024).
  readonly sshdUser: string;
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
  // What create offers on this OS.
  readonly offer: OsOffer;
  readonly defaultSize: Size;
  // What create asks Namespace for, past the size.
  readonly machine: {
    readonly arch: "amd64" | "arm64";
    readonly selectors: ReadonlyArray<{
      readonly name: string;
      readonly value: string;
    }>;
  };
  // Makes the Sandbox once Namespace has made the host and its gateway
  // link is open.
  readonly make: (
    link: Link,
    made: MakeRequest,
  ) => Effect.Effect<
    SandboxInfo,
    CreateError | SandboxGoneError,
    Progress | Scope.Scope
  >;
  // Where proofbox keeps its own files in the Sandbox.
  readonly folders: SandboxFolders;
}

// What create hands a host once Namespace has made it.
export interface MakeRequest {
  readonly req: Parameters<Provider["create"]>[0];
  readonly ref: SandboxRef;
  readonly paths: KeeperPaths;
  readonly size: Size;
  readonly maxLifeAt: Date;
}

// A host fails only with what create may fail with.
type CreateError = Effect.Effect.Error<ReturnType<Provider["create"]>>;

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

// Adds this Sandbox's key to the login's authorized_keys over the gateway
// link, runs the OS's line that starts sshd and prints its ed25519 host key,
// and pins that key (ADR 0024). False when the host gives no key.
export const turnOnSshd = Effect.fn("namespaceHost.turnOnSshd")(function* (
  link: Link,
  paths: KeeperPaths,
  fs: FileSystem.FileSystem,
  start: string,
) {
  const pub = yield* fs.readFileString(`${paths.key}.pub`).pipe(
    Effect.map((text) => text.trim()),
    Effect.mapError((error) => fail(platformReason(error))),
  );
  const result = yield* link.run(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && { grep -qxF ${shellJoin([pub])} ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${shellJoin([pub])} >> ~/.ssh/authorized_keys; } && chmod 600 ~/.ssh/authorized_keys && ${start}`,
  );
  if (result.exitCode !== 0 || !/^ssh-ed25519 \S+/.test(result.stdout)) {
    return false;
  }
  const [type, key] = result.stdout.trim().split(/\s+/);
  yield* fs
    .writeFileString(paths.sshdKnownHosts, `127.0.0.1 ${type} ${key}\n`, {
      mode: 0o600,
    })
    .pipe(Effect.mapError((error) => fail(platformReason(error))));
  return true;
});
