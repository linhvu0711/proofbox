import { Effect, Stream } from "effect";
import type { DockerClient } from "../../src/docker/docker-client.ts";

// A Docker client a test must never reach: each call dies, so a test that
// strays onto Docker fails at once. Spread it and answer only the calls a
// test makes.
const why = "the Docker client is not part of this test";

export const unusedDockerClient: DockerClient = {
  serverArch: Effect.die(why),
  imageExists: () => Effect.die(why),
  pull: () => Effect.die(why),
  push: () => Effect.die(why),
  commit: () => Effect.die(why),
  repoDigest: () => Effect.die(why),
  registryDigests: () => Effect.die(why),
  build: () => Effect.die(why),
  run: () => Effect.die(why),
  execText: () => Effect.die(why),
  execStream: () => Stream.die(why),
  inspect: () => Effect.die(why),
  listNames: Effect.die(why),
  remove: () => Effect.die(why),
};
