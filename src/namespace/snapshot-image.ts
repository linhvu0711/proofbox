import { Effect } from "effect";
import { ProviderError } from "../errors.ts";
import type { Link } from "./ssh-link.ts";

const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

export const snapshotTag = (tenant: string, fp: string) =>
  `nscr.io/${tenant}/proofbox-snapshot-linux:${fp}`;

export const pullSnapshot = (link: Link, tag: string) =>
  Effect.gen(function* () {
    const result = yield* link.run(`docker pull ${tag}`);
    if (result.exitCode === 0) {
      return "pulled" as const;
    }
    // A Snapshot nobody saved yet is "manifest unknown" (or "not found" on
    // older registries) — that is the normal miss, not a failure.
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

// The expiry call runs the host's own nsc: the instance token under
// /var/run/nsc/token.json is the only credential the workspace registry
// accepts; the Caller's login may be a compute-only CI token. stdin is
// closed because table output wants a tty.
export const ensureImageExpiry = (link: Link, ref: string, hours: number) =>
  Effect.gen(function* () {
    const result = yield* link.run(
      `/nsc/bin/nsc registry update-image-expiration ${ref} --ensure-minimum ${hours}h </dev/null`,
    );
    if (result.exitCode !== 0) {
      return yield* fail(
        `nsc registry update-image-expiration failed: ${result.stderr.trim()}`,
      );
    }
  });

// The digest a pushed image got, as `<repo>@sha256:<digest>` — the form
// `nsc registry update-image-expiration` takes.
export const snapshotRef = (link: Link, tag: string) =>
  Effect.gen(function* () {
    const result = yield* link.run(
      `docker image inspect --format '{{index .RepoDigests 0}}' ${tag}`,
    );
    if (result.exitCode !== 0) {
      return yield* fail(
        `docker image inspect failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim().split("/").slice(2).join("/");
  });
