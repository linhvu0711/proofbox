import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  type DockerHost,
  makeDockerClient,
} from "../src/docker/docker-client.ts";
import { ProviderUnavailableError } from "../src/errors.ts";
import { linkDockerHost } from "../src/namespace/link-docker.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";
import { fakeSshMaster, openKeeperLink } from "./support/fake-ssh.ts";

describe("Docker client over a Namespace link", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  it.live(
    "a docker exec over a dropped Keeper link opens a new master first",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
      trackTempDir(dir);
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      trackTempDir(runtime);
      const fake = fakeSshMaster(dir);
      return Effect.gen(function* () {
        // Given: a Keeper link whose master dropped after its first run
        const { link } = yield* openKeeperLink(fake, [
          { id: "abc123def4567", labels: {} },
        ]);
        yield* link.run("true");
        rmSync(join(dir, "alive"));
        const docker = makeDockerClient(
          yield* CommandExecutor.CommandExecutor,
          linkDockerHost(link),
        );
        // When
        const events = yield* Stream.runCollect(
          docker.execStream("proofbox-abc123", ["true"], undefined, "root"),
        );
        // Then
        expect({
          masterStarts: fake.masterStarts(),
          events: Chunk.toReadonlyArray(events).map((event) =>
            event._tag === "Exit"
              ? { _tag: event._tag, code: event.code }
              : {
                  _tag: event._tag,
                  text: Buffer.from(event.bytes).toString("utf8"),
                },
          ),
        }).toEqual({
          masterStarts: 2,
          events: [
            { _tag: "Stdout", text: "ok\n" },
            { _tag: "Exit", code: 0 },
          ],
        });
      }).pipe(
        Effect.scoped,
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["PROOFBOX_RUNTIME_DIR", runtime],
              ["PROOFBOX_NS_LINK_WAIT", "0s"],
            ]),
          ),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );

  it.live("a build over a dropped Keeper link opens a new master first", () => {
    const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
    trackTempDir(dir);
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    trackTempDir(runtime);
    const folder = mkdtempSync(join(tmpdir(), "proofbox-build-"));
    trackTempDir(folder);
    writeFileSync(join(folder, "Dockerfile"), "FROM scratch\n");
    const fake = fakeSshMaster(dir);
    return Effect.gen(function* () {
      // Given: a Keeper link whose master dropped after its first run
      const { link } = yield* openKeeperLink(fake, [
        { id: "abc123def4567", labels: {} },
      ]);
      yield* link.run("true");
      rmSync(join(dir, "alive"));
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        linkDockerHost(link),
      );
      // When
      yield* docker.build({
        dir: folder,
        tag: "proofbox-test:1",
        buildArgs: {},
      });
      // Then
      expect(fake.masterStarts()).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PROOFBOX_RUNTIME_DIR", runtime],
            ["PROOFBOX_NS_LINK_WAIT", "0s"],
          ]),
        ),
      ),
      Effect.provide(NodeContext.layer),
    );
  });
});

describe("Docker client build", () => {
  it.live("a build whose folder tar fails reports the tar", () => {
    const parent = mkdtempSync(join(tmpdir(), "proofbox-build-"));
    trackTempDir(parent);
    const folder = join(parent, "missing");
    // A host that reads the whole build input, then answers exit 0.
    const host: DockerHost = {
      provider: "docker",
      run: () => Effect.die("not used"),
      stream: (_argv, options) =>
        Stream.unwrap(
          Effect.as(
            options?.stdin === undefined
              ? Effect.void
              : Stream.runDrain(options.stdin),
            Stream.make({ _tag: "Exit" as const, code: 0 }),
          ),
        ),
      unavailable: new ProviderUnavailableError({
        provider: "docker",
        reason: "not used",
      }),
    };
    return Effect.gen(function* () {
      // Given
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        host,
      );
      // When
      const error = yield* Effect.flip(
        docker.build({ dir: folder, tag: "proofbox-test:1", buildArgs: {} }),
      );
      // Then
      expect({
        _tag: error._tag,
        packs:
          error._tag === "ProviderError" &&
          error.reason.startsWith(
            `could not pack the build folder ${folder}: tar exited`,
          ),
      }).toEqual({ _tag: "ProviderError", packs: true });
    }).pipe(Effect.provide(NodeContext.layer));
  });
});
