import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
  ensureBaseImage,
  toolBundleArgs,
  toolBundleForArch,
} from "../../src/docker/base-image.ts";
import { makeDockerClient } from "../../src/docker/docker-client.ts";
import { TOOL_BUNDLE } from "../../src/tool-bundle.ts";

export default async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const client = makeDockerClient(executor);
      const version = yield* baseImageVersion(BASE_IMAGE_DIR, TOOL_BUNDLE);
      const arch = yield* client.serverArch;
      yield* ensureBaseImage(client, {
        dir: BASE_IMAGE_DIR,
        tag: baseImageTag(version),
        buildArgs: {
          BASE_VERSION: version,
          ...toolBundleArgs(yield* toolBundleForArch(arch)),
        },
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
};
