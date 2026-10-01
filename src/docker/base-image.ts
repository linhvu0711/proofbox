import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { packagePath } from "../entry.ts";
import { ProviderError } from "../errors.ts";
import { Progress } from "../progress.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import type { DockerClient } from "./docker-client.ts";

export const BASE_IMAGE_DIR = packagePath("images/linux/");

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

export interface ToolBundleFile {
  readonly name: string;
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
}

export const toolBundleForArch = Effect.fn("baseImage.toolBundleForArch")(
  function* (arch: string) {
    if (arch !== "amd64" && arch !== "arm64") {
      return yield* new ProviderError({
        provider: "docker",
        reason: `no Tool bundle for ${arch}`,
      });
    }
    return LINUX_TOOL_BUNDLE.map((file) => ({
      name: file.name,
      path: file.path,
      url: file.linux[arch].url,
      sha256: file.linux[arch].sha256,
    }));
  },
);

export const toolBundleArgs = (
  files: ReadonlyArray<ToolBundleFile>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    files.flatMap((file) => [
      [`${file.name.toUpperCase()}_URL`, file.url],
      [`${file.name.toUpperCase()}_SHA256`, file.sha256],
    ]),
  );

export const ensureBaseImage = Effect.fn("baseImage.ensureBaseImage")(
  function* (
    client: DockerClient,
    image: {
      readonly dir: string;
      readonly tag: string;
      readonly buildArgs: Readonly<Record<string, string>>;
    },
    options?: { readonly registry?: boolean | undefined },
  ) {
    if (yield* client.imageExists(image.tag)) {
      return;
    }
    if (options?.registry === true && (yield* client.pull(image.tag))) {
      return;
    }
    const progress = yield* Progress;
    yield* progress.step("building the Base image", client.build(image));
    if (options?.registry === true) {
      yield* client.push(image.tag);
    }
  },
);
