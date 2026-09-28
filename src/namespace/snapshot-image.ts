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
export const pullSnapshot = (link: Link, tag: string) =>
  Effect.gen(function* () {
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

export const pushSnapshot = (link: Link, container: string, tag: string) =>
  Effect.gen(function* () {
    const result = yield* link.run(
      `docker commit ${container} ${tag} && docker push ${tag}`,
    );
    if (result.exitCode !== 0) {
      return yield* fail(`docker push failed: ${result.stderr.trim()}`);
    }
  });

// The pushed image as `<repo>@sha256:<digest>`, the form
// `nsc registry update-image-expiration` takes, without the registry host
// and tenant.
export const snapshotRef = (link: Link, tag: string) =>
  Effect.gen(function* () {
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
