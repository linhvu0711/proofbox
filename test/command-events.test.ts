import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Effect, Option, Stream } from "effect";
import { describe, expect } from "vitest";
import { commandEvents } from "../src/command-events.ts";

describe("command events", () => {
  it.live("a command with no stdin reads end of input at once", () =>
    Effect.gen(function* () {
      // Given
      const executor = yield* CommandExecutor.CommandExecutor;
      // When
      const events = yield* commandEvents(
        executor,
        Command.make("sh", "-c", 'read x; echo "rc:$?"'),
        undefined,
        {
          spawn: (error) => error.message,
          fail: (reason) => reason,
        },
      ).pipe(
        Stream.runCollect,
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => "no end of input within 5 s",
        }),
      );
      // Then
      const stdout = Chunk.toReadonlyArray(events).flatMap((event) =>
        event._tag === "Stdout" ? [new TextDecoder().decode(event.bytes)] : [],
      );
      expect({
        stdout: stdout.join(""),
        last: Option.getOrUndefined(Chunk.last(events)),
      }).toEqual({ stdout: "rc:1\n", last: { _tag: "Exit", code: 0 } });
    }).pipe(Effect.provide(NodeContext.layer)),
  );
});
