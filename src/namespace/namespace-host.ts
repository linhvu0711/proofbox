import type { FileSystem } from "@effect/platform";
import { Effect, type Scope } from "effect";
import type { ChecksShell, Transport } from "../command-checks.ts";
import {
  type LinkDroppedError,
  ProviderError,
  type ProviderUnavailableError,
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
import type { Size } from "../size.ts";
import type { HostResult, Link } from "./ssh-link.ts";

// What the Namespace Provider asks of one host's OS. The Provider keeps the
// Namespace API calls and list, and create (`namespace-create.ts`) runs the
// create flow once; a Linux host and a Mac host each do the steps that
// differ by OS.
export interface NamespaceHost {
  readonly os: Os;
  // How create turns on the host's own sshd (ADR 0024).
  readonly sshd: {
    // Installs sshd on a host that lacks it.
    readonly install?: string | undefined;
    // Starts sshd and prints its ed25519 host key.
    readonly start: string;
    // The user sshd logs in as.
    readonly user: string;
  };
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
  ) => Effect.Effect<
    HostResult,
    ProviderError | ProviderUnavailableError | SandboxGoneError
  >;
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
    | ProviderError
    | ProviderUnavailableError
    | SandboxGoneError
    | LinkDroppedError,
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
  // Prepares the Sandbox once create has turned on the host's sshd and
  // opened its link.
  readonly prepare: (
    sshd: Link,
    made: MakeRequest,
  ) => Effect.Effect<
    SandboxInfo,
    CreateError | SandboxGoneError | LinkDroppedError,
    Progress
  >;
  // Where proofbox keeps its own files in the Sandbox.
  readonly folders: SandboxFolders;
}

// What create hands a host once Namespace has made it.
export interface MakeRequest {
  readonly req: Parameters<Provider["create"]>[0];
  readonly ref: SandboxRef;
  readonly size: Size;
  readonly maxLifeAt: Date;
}

// A host fails only with what create may fail with.
type CreateError = Effect.Effect.Error<ReturnType<Provider["create"]>>;

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

// The gateway key and the stored gateway target sit next to a link's
// control socket.
export const linkFiles = (control: string) => {
  const stem = control.replace(/\.ctl$/, "");
  return { key: `${stem}.sshkey`, target: `${stem}.sshtarget` };
};

// Create's cleanup, delete, and the list prune all remove a host's local
// files, so they share one list.
export const removeHostFiles = Effect.fn("namespaceHost.removeHostFiles")(
  function* (paths: KeeperPaths, fs: FileSystem.FileSystem) {
    const link = linkFiles(paths.control);
    yield* Effect.forEach(
      [
        paths.key,
        `${paths.key}.pub`,
        paths.maxLife,
        paths.deadline,
        paths.os,
        paths.control,
        paths.socket,
        link.key,
        link.target,
        paths.knownHosts,
        paths.sshdKnownHosts,
      ],
      (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );
  },
);
