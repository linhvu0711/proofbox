import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeDockerClient } from "../src/docker/docker-client.ts";
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
          link,
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
});
