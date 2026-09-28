import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
  ensureBaseImage,
} from "../../src/docker/base-image.ts";
import { makeDockerClient } from "../../src/docker/docker-client.ts";

export default async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const client = makeDockerClient(executor);
      const version = yield* baseImageVersion(BASE_IMAGE_DIR, []);
      yield* ensureBaseImage(client, {
        dir: BASE_IMAGE_DIR,
        tag: baseImageTag(version),
        buildArgs: { BASE_VERSION: version },
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
};
