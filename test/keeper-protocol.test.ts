import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Chunk, Effect, Stream } from "effect";
import { describe, expect } from "vitest";
import { readReplies, writeFrame } from "../src/keeper/protocol.ts";

// Two ends of one Unix socket: `keeper` writes as a Keeper does, `caller`
// reads as the CLI does. Gone with the test's scope.
const socketPair = Effect.acquireRelease(
  Effect.async<{
    readonly dir: string;
    readonly close: () => Promise<void>;
    readonly keeper: Socket;
    readonly caller: Socket;
  }>((resume) => {
    // macOS caps a socket path near 104 bytes, and its tmpdir is long.
    const dir = mkdtempSync(
      join(
        process.platform === "darwin" ? "/tmp" : tmpdir(),
        "proofbox-protocol-",
      ),
    );
    const path = join(dir, "k.sock");
    const server = createServer();
    server.listen(path, () => {
      const caller = createConnection({ path });
      server.once("connection", (keeper) =>
        resume(
          Effect.succeed({
            dir,
            close: () =>
              new Promise<void>((done) => server.close(() => done())),
            keeper,
            caller,
          }),
        ),
      );
    });
  }),
  (pair) =>
    Effect.promise(() => {
      pair.keeper.destroy();
      pair.caller.destroy();
      return pair.close();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => rmSync(pair.dir, { recursive: true, force: true })),
      ),
    ),
);

describe("Keeper protocol", () => {
  it.scoped("replies end after the exit frame", () =>
    Effect.gen(function* () {
      // Given
      const { keeper, caller } = yield* socketPair;
      yield* writeFrame(keeper, "fake", { out: "aGk=" });
      yield* writeFrame(keeper, "fake", { exit: 0 });
      yield* writeFrame(keeper, "fake", { out: "bGF0ZQ==" });
      // When
      const replies = yield* Stream.runCollect(readReplies(caller, "fake"));
      // Then
      expect(Chunk.toReadonlyArray(replies)).toEqual([
        { out: "aGk=" },
        { exit: 0 },
      ]);
    }),
  );

  it.scoped("a socket that closes before the last frame fails as lost", () =>
    Effect.gen(function* () {
      // Given
      const { keeper, caller } = yield* socketPair;
      yield* writeFrame(keeper, "fake", { out: "aGk=" });
      keeper.end();
      // When
      const error = yield* readReplies(caller, "fake").pipe(
        Stream.runDrain,
        Effect.flip,
      );
      // Then
      expect({ tag: error._tag, reason: error.reason }).toEqual({
        tag: "KeeperLostError",
        reason: undefined,
      });
    }),
  );

  it.scoped("a line that does not decode fails with the decode error", () =>
    Effect.gen(function* () {
      // Given
      const { keeper, caller } = yield* socketPair;
      keeper.end("not json\n");
      // When
      const error = yield* readReplies(caller, "fake").pipe(
        Stream.runDrain,
        Effect.flip,
      );
      // Then
      expect(error).toMatchObject({
        _tag: "ProviderError",
        provider: "fake",
        reason: `Unexpected token 'o', "not json" is not valid JSON`,
      });
    }),
  );
});
