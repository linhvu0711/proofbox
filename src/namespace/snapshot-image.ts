import { Effect } from "effect";
import { ProviderError } from "../errors.ts";
import type { Link } from "./ssh-link.ts";

// A Snapshot is a committed Sandbox container, kept in the tenant's
// registry next to the Base image. These commands run on the host, over
// the link, so the image never passes through the Caller's machine.

const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

export const snapshotTag = (tenant: string, fingerprint: string) =>
  `nscr.io/${tenant}/proofbox-snapshot-linux:${fingerprint}`;

// "missing" is the normal miss: no Snapshot has this Fingerprint yet.
export const pullSnapshot = Effect.fn("snapshotImage.pullSnapshot")(function* (
  link: Link,
  tag: string,
) {
  const result = yield* link.run(`docker pull ${tag}`);
  if (result.exitCode === 0) {
    return "pulled" as const;
  }
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes("manifest unknown") || stderr.includes("not found")) {
    return "missing" as const;
  }
  return yield* fail(`docker pull failed: ${result.stderr.trim()}`);
});

// No pause: a paused container fails every `docker exec`, and the Keeper
// reads that as a broken Sandbox and closes the link this push runs on.
// The Setup script has ended by now, so nothing is mid-write.
export const pushSnapshot = Effect.fn("snapshotImage.pushSnapshot")(function* (
  link: Link,
  container: string,
  tag: string,
) {
  const result = yield* link.run(
    `docker commit --pause=false ${container} ${tag} && docker push ${tag}`,
  );
  if (result.exitCode !== 0) {
    return yield* fail(`docker push failed: ${result.stderr.trim()}`);
  }
});

// The pushed image as `<repo>@sha256:<digest>`, split at `@` into the
// Registry API's `repository` and `digest`, without the registry host and
// tenant.
export const snapshotRef = Effect.fn("snapshotImage.snapshotRef")(function* (
  link: Link,
  tag: string,
) {
  const result = yield* link.run(
    `docker image inspect --format '{{index .RepoDigests 0}}' ${tag}`,
  );
  const ref = result.stdout.trim();
  const prefix = tag.slice(0, tag.lastIndexOf("/") + 1);
  if (result.exitCode !== 0 || !ref.startsWith(prefix)) {
    return yield* fail(
      `could not read the Snapshot digest: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return ref.slice(prefix.length);
});
