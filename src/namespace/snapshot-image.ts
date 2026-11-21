import { Option } from "effect";

// A Snapshot is a committed Sandbox container, kept in the tenant's
// registry next to the Base image, so the image never passes through the
// Caller's machine.

export const snapshotTag = (tenant: string, fingerprint: string) =>
  `nscr.io/${tenant}/proofbox-snapshot-linux:${fingerprint}`;

// The pushed image's repo digest as `<repo>@sha256:<digest>`, split at `@`
// into the Registry API's `repository` and `digest`, without the registry
// host and tenant. None when the digest is not under the tag's registry.
export const snapshotRef = (tag: string, digest: string) => {
  const prefix = tag.slice(0, tag.lastIndexOf("/") + 1);
  return digest.startsWith(prefix)
    ? Option.some(digest.slice(prefix.length))
    : Option.none();
};
