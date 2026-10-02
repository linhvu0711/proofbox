import { Effect, Schema } from "effect";
import { ProviderError } from "../errors.ts";
import type { Link } from "./ssh-link.ts";

// Every digest an image tag holds in the tenant's registry, read on the
// host over the link without a pull. A Base push is an index plus its
// image and attestation manifests, and the Registry API expires each
// digest on its own.

const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

const Manifest = Schema.Struct({
  digest: Schema.String,
  manifests: Schema.optional(
    Schema.Array(Schema.Struct({ digest: Schema.String })),
  ),
});

// Each digest as `<repo>@sha256:<digest>`, the Registry API's
// `repository` and `digest` without the registry host and tenant.
// "missing" when the registry does not hold the tag.
export const registryRefs = Effect.fn("registryRefs.registryRefs")(function* (
  link: Link,
  tag: string,
) {
  const result = yield* link.run(
    `docker buildx imagetools inspect --format '{{json .Manifest}}' ${tag}`,
  );
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("manifest unknown") || stderr.includes("not found")) {
      return "missing" as const;
    }
    return yield* fail(
      `docker buildx imagetools inspect failed: ${result.stderr.trim()}`,
    );
  }
  const manifest = yield* Schema.decodeUnknown(Schema.parseJson(Manifest))(
    result.stdout,
  ).pipe(
    Effect.mapError(() => fail(`could not read the image digests of ${tag}`)),
  );
  const repo = tag.slice(tag.lastIndexOf("/") + 1, tag.lastIndexOf(":"));
  return [
    manifest.digest,
    ...(manifest.manifests ?? []).map((child) => child.digest),
  ].map((digest) => `${repo}@${digest}`);
});
