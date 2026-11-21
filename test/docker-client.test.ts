import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  type DockerExecResult,
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
  // A host that reads the whole build input, then answers exit 0. It keeps
  // the byte count it read in `received`.
  const readingHost = (received: { bytes: number }): DockerHost => ({
    provider: "docker",
    run: () => Effect.die("not used"),
    stream: (_argv, options) =>
      Stream.unwrap(
        Effect.as(
          options?.stdin === undefined
            ? Effect.void
            : Stream.runForEach(options.stdin, (chunk) =>
                Effect.sync(() => {
                  received.bytes += chunk.length;
                }),
              ),
          Stream.make({ _tag: "Exit" as const, code: 0 }),
        ),
      ),
    unavailable: new ProviderUnavailableError({
      provider: "docker",
      reason: "not used",
    }),
  });

  it.live("a build with TAPE set sends the folder to Docker", () => {
    const parent = mkdtempSync(join(tmpdir(), "proofbox-build-"));
    trackTempDir(parent);
    const folder = join(parent, "context");
    mkdirSync(folder);
    writeFileSync(join(folder, "Dockerfile"), "FROM scratch\n");
    const archive = join(parent, "work.tar");
    writeFileSync(archive, "keep");
    const received = { bytes: 0 };
    return Effect.gen(function* () {
      // Given: every command the client starts has TAPE set to an archive
      const executor = yield* CommandExecutor.CommandExecutor;
      const docker = makeDockerClient(
        CommandExecutor.makeExecutor((command) =>
          executor.start(Command.env(command, { TAPE: archive })),
        ),
        readingHost(received),
      );
      // When
      yield* docker.build({
        dir: folder,
        tag: "proofbox-test:1",
        buildArgs: {},
      });
      // Then
      expect({
        sent: received.bytes > 0,
        archive: readFileSync(archive, "utf8"),
      }).toEqual({ sent: true, archive: "keep" });
    }).pipe(Effect.provide(NodeContext.layer));
  });

  // Root reads a mode 000 folder, so tar writes no errors there.
  it.live.skipIf(process.getuid?.() === 0)(
    "a build whose folder tar writes many errors reports the tar",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "proofbox-build-"));
      trackTempDir(parent);
      const folder = join(parent, "context");
      mkdirSync(folder);
      // Each unreadable folder is one tar error line; 3000 lines are more
      // than a pipe holds.
      const locked = Array.from({ length: 3000 }, (_, index) =>
        join(folder, String(index).padStart(200, "d")),
      );
      for (const path of locked) {
        mkdirSync(path);
        chmodSync(path, 0o000);
      }
      return Effect.gen(function* () {
        // Given
        const docker = makeDockerClient(
          yield* CommandExecutor.CommandExecutor,
          readingHost({ bytes: 0 }),
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
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const path of locked) {
              chmodSync(path, 0o700);
            }
          }),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
    20_000,
  );

  it.live("a build whose folder tar fails reports the tar", () => {
    const parent = mkdtempSync(join(tmpdir(), "proofbox-build-"));
    trackTempDir(parent);
    const folder = join(parent, "missing");
    const host = readingHost({ bytes: 0 });
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

describe("Docker client pull", () => {
  const Tag = "nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e";

  // A host that answers every text call with `result`, and keeps the argv
  // of each call in `argvs`.
  const answeringHost = (
    result: DockerExecResult,
    argvs: Array<ReadonlyArray<string>> = [],
  ): DockerHost => ({
    provider: "namespace",
    run: (argv) =>
      Effect.sync(() => {
        argvs.push(argv);
        return result;
      }),
    stream: () => Stream.die("not used"),
    unavailable: new ProviderUnavailableError({
      provider: "namespace",
      reason: "not used",
    }),
  });

  it.live("a pull of a tag the registry holds answers pulled", () =>
    Effect.gen(function* () {
      // Given: Docker pulls the tag
      const argvs: Array<ReadonlyArray<string>> = [];
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        answeringHost({ exitCode: 0, stdout: "", stderr: "" }, argvs),
      );
      // When
      const answer = yield* docker.pull(Tag);
      // Then
      expect({ answer, argvs }).toEqual({
        answer: "pulled",
        argvs: [["pull", Tag]],
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("a pull of a tag the registry lacks answers missing", () =>
    Effect.gen(function* () {
      // Given: the registry has no manifest for the tag
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        answeringHost({
          exitCode: 1,
          stdout: "",
          stderr: "Error response from daemon: manifest unknown\n",
        }),
      );
      // When
      const answer = yield* docker.pull(Tag);
      // Then
      expect(answer).toBe("missing");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("a pull of a tag that is not found answers missing", () =>
    Effect.gen(function* () {
      // Given: the registry says the tag is not found
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        answeringHost({
          exitCode: 1,
          stdout: "",
          stderr: `Error response from daemon: ${Tag}: not found\n`,
        }),
      );
      // When
      const answer = yield* docker.pull(Tag);
      // Then
      expect(answer).toBe("missing");
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live(
    "a pull that fails for another reason fails with the docker error",
    () =>
      Effect.gen(function* () {
        // Given: the registry does not answer, after one layer line
        const docker = makeDockerClient(
          yield* CommandExecutor.CommandExecutor,
          answeringHost({
            exitCode: 1,
            stdout: "22d0cf15eb8e: Pulling fs layer\n",
            stderr: "dial tcp: i/o timeout\n",
          }),
        );
        // When
        const error = yield* Effect.flip(docker.pull(Tag));
        // Then
        expect({ _tag: error._tag, message: error.message }).toEqual({
          _tag: "ProviderError",
          message:
            "Provider namespace failed: docker pull failed: dial tcp: i/o timeout",
        });
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("Docker client registry digests", () => {
  const Tag = "nscr.io/tenant_x/proofbox-base-linux:0123456789ab";

  // The Base tag's digests as `docker buildx imagetools inspect` prints
  // them: the index and its 2 children.
  const BaseIndex = JSON.stringify({
    digest: "sha256:ba5e",
    manifests: [{ digest: "sha256:cd34" }, { digest: "sha256:ef56" }],
  });

  const answeringHost = (
    result: DockerExecResult,
    argvs: Array<ReadonlyArray<string>> = [],
  ): DockerHost => ({
    provider: "namespace",
    run: (argv) =>
      Effect.sync(() => {
        argvs.push(argv);
        return result;
      }),
    stream: () => Stream.die("not used"),
    unavailable: new ProviderUnavailableError({
      provider: "namespace",
      reason: "not used",
    }),
  });

  it.live("registry digests list the index and each child manifest", () =>
    Effect.gen(function* () {
      // Given: the registry holds the index and its 2 children
      const argvs: Array<ReadonlyArray<string>> = [];
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        answeringHost({ exitCode: 0, stdout: BaseIndex, stderr: "" }, argvs),
      );
      // When
      const digests = yield* docker.registryDigests(Tag);
      // Then
      expect({ digests, argvs }).toEqual({
        digests: ["sha256:ba5e", "sha256:cd34", "sha256:ef56"],
        argvs: [
          [
            "buildx",
            "imagetools",
            "inspect",
            "--format",
            "{{json .Manifest}}",
            Tag,
          ],
        ],
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live("registry digests answer missing for a tag the registry lacks", () =>
    Effect.gen(function* () {
      // Given: the registry says the tag is not found
      const docker = makeDockerClient(
        yield* CommandExecutor.CommandExecutor,
        answeringHost({
          exitCode: 1,
          stdout: "",
          stderr: `ERROR: ${Tag}: not found\n`,
        }),
      );
      // When
      const digests = yield* docker.registryDigests(Tag);
      // Then
      expect(digests).toBe("missing");
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
