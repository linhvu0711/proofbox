import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { ProviderError } from "../errors.ts";
import type { DockerClient, DockerError } from "./docker-client.ts";

export const BASE_IMAGE_DIR = fileURLToPath(
  new URL("../../images/linux/", import.meta.url),
);

export const baseImageVersion = (
  dir: string,
  bundle: ReadonlyArray<unknown>,
): Effect.Effect<string, ProviderError> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          relative(dir, join(entry.parentPath, entry.name)).replaceAll(
            "\\",
            "/",
          ),
        )
        .sort();
      const hash = createHash("sha256");
      for (const path of files) {
        hash.update(`${path}\0`);
        hash.update(await readFile(join(dir, path)));
        hash.update("\0");
      }
      hash.update(JSON.stringify(bundle));
      return hash.digest("hex").slice(0, 12);
    },
    catch: (cause) =>
      new ProviderError({
        provider: "docker",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const baseImageTag = (version: string) =>
  `proofbox-base-linux:${version}`;

export const ensureBaseImage = (
  client: DockerClient,
  image: {
    readonly dir: string;
    readonly tag: string;
    readonly buildArgs: Readonly<Record<string, string>>;
  },
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    if (yield* client.imageExists(image.tag)) {
      return;
    }
    yield* client.build(image);
  });
