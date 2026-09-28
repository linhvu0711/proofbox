import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Ref, Stream, TestClock } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import {
  baseImageVersion,
  ensureBaseImage,
} from "../src/docker/base-image.ts";
import type {
  DockerClient,
  DockerError,
} from "../src/docker/docker-client.ts";
import { Progress } from "../src/progress.ts";

const stubClient = (
  imageExists: boolean,
  build: Effect.Effect<void, DockerError>,
): DockerClient => ({
  serverArch: Effect.die("unused"),
  imageExists: () => Effect.succeed(imageExists),
  build: () => build,
  run: () => Effect.die("unused"),
  execText: () => Effect.die("unused"),
  execStream: () => Stream.die("unused"),
  inspect: () => Effect.die("unused"),
  listNames: Effect.die("unused"),
  remove: () => Effect.die("unused"),
});

describe("Base image", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.effect("baseImageVersion hashes the image files and the Tool bundle", () =>
    Effect.gen(function* () {
      // Given: an image dir, and the same dir with one file changed
      const dir = mkdtempSync(join(tmpdir(), "proofbox-image-"));
      dirs.push(dir);
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(dir, "init.sh"), "#!/bin/sh\n");
      // When
      const first = yield* baseImageVersion(dir, []);
      writeFileSync(join(dir, "Dockerfile"), "FROM debian\n");
      const second = yield* baseImageVersion(dir, []);
      // Then
      expect(first).toBe("8c858f0d6b7a");
      expect(second).toBe("dda6097aecf9");
    }),
  );

  it.effect("a slow Base image build prints progress on stderr", () =>
    Effect.gen(function* () {
      // Given: no cached image and a build that takes 40 seconds
      const fiber = yield* Effect.fork(
        ensureBaseImage(stubClient(false, Effect.sleep("40 seconds")), {
          dir: "/unused",
          tag: "proofbox-base-linux:test",
          buildArgs: {},
        }),
      );
      // When
      yield* TestClock.adjust("40 seconds");
      yield* Fiber.join(fiber);
      // Then
      const output = yield* CliOutput;
      const err = Chunk.toReadonlyArray(
        yield* Ref.get(output.captured.err),
      ).join("");
      expect(err).toBe(
        "proofbox: building the Base image\nproofbox: still building the Base image (15 s)\nproofbox: still building the Base image (30 s)\n",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
    ),
  );

  it.effect("a Base image that exists is not built again", () =>
    Effect.gen(function* () {
      // Given: the image tag already exists
      const client = stubClient(
        true,
        Effect.die("should not build"),
      ) as DockerClient;
      // When
      yield* ensureBaseImage(client, {
        dir: "/unused",
        tag: "proofbox-base-linux:test",
        buildArgs: {},
      });
      // Then: nothing printed
      const output = yield* CliOutput;
      const err = Chunk.toReadonlyArray(
        yield* Ref.get(output.captured.err),
      ).join("");
      expect(err).toBe("");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
    ),
  );
});
