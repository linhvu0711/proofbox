import { createHash } from "node:crypto";
// biome-ignore lint/style/noRestrictedImports: FileSystem has no Dirent readdir, and stat would follow links.
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { packagePath } from "../entry.ts";
import { causeText, ProviderError, platformReason } from "../errors.ts";
import { Progress } from "../progress.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import type { DockerClient } from "./docker-client.ts";

export const BASE_IMAGE_DIR = packagePath("images/linux/");

export const baseImageVersion = (
  dir: string,
  bundle: ReadonlyArray<unknown>,
): Effect.Effect<string, ProviderError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir, { recursive: true, withFileTypes: true }),
      catch: (cause) =>
        new ProviderError({
          provider: "docker",
          reason: causeText(cause),
        }),
    });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
      )
      .sort();
    const hash = createHash("sha256");
    for (const path of files) {
      hash.update(`${path}\0`);
      hash.update(
        yield* fs.readFile(join(dir, path)).pipe(
          Effect.mapError(
            (error) =>
              new ProviderError({
                provider: "docker",
                reason: platformReason(error),
              }),
          ),
        ),
      );
      hash.update("\0");
    }
    hash.update(JSON.stringify(bundle));
    return hash.digest("hex").slice(0, 12);
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
  function* <E>(
    client: DockerClient<E>,
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
    const progress = yield* Progress;
    if (options?.registry === true) {
      const pulled = yield* progress
        .step("pulling the Base image", client.pull(image.tag))
        .pipe(
          Effect.catchIf(
            (error): error is ProviderError => error instanceof ProviderError,
            (error) =>
              progress
                .warn(
                  `could not pull the Base image (${error.message}); building it`,
                )
                .pipe(Effect.as("failed" as const)),
          ),
        );
      if (pulled === "pulled") {
        return;
      }
    }
    yield* progress.step("building the Base image", client.build(image));
    if (options?.registry === true) {
      yield* client.push(image.tag);
    }
  },
);
