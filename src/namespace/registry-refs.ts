// Every digest an image tag holds in the tenant's registry, as the Registry
// API names it. A Base push is an index plus its image and attestation
// manifests, and the Registry API expires each digest on its own.

// Each digest as `<repo>@sha256:<digest>`, the Registry API's `repository`
// and `digest` without the registry host and tenant.
export const registryRefs = (
  tag: string,
  digests: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const repo = tag.slice(tag.lastIndexOf("/") + 1, tag.lastIndexOf(":"));
  return digests.map((digest) => `${repo}@${digest}`);
};
