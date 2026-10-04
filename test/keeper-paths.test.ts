import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { ownStart, stillRuns } from "../src/keeper/paths.ts";
import { nodeFs } from "./support/node-fs.ts";

// Linux reads a start time from /proc and never runs ps.
const onLinux = process.platform === "linux";

describe("Keeper start times", () => {
  it.live.skipIf(onLinux)(
    "stillRuns knows this process by its start time",
    () =>
      Effect.gen(function* () {
        // Given
        const own = yield* ownStart;
        // When
        const answers = [
          yield* stillRuns(process.pid, own),
          yield* stillRuns(process.pid, "Thu Jan  1 00:00:00 1970"),
        ];
        // Then
        expect(answers).toEqual([true, false]);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.live.skipIf(onLinux)(
    "stillRuns says no for a process that has ended",
    () =>
      Effect.gen(function* () {
        // Given: a process that ran and ended
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* Command.start(Command.make("true"));
            yield* child.exitCode;
            return child.pid;
          }),
        );
        // When
        const runs = yield* stillRuns(pid, "");
        // Then
        expect(runs).toBe(false);
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect.skipIf(onLinux)(
    "stillRuns counts a process this user runs when ps cannot answer, and runs ps with only LC_ALL=C",
    () =>
      Effect.gen(function* () {
        // Given: an executor that records each command and cannot spawn it
        const seen: Array<Command.Command> = [];
        const noPs = CommandExecutor.makeExecutor((command) => {
          seen.push(command);
          return Effect.fail(
            new SystemError({
              reason: "NotFound",
              module: "Command",
              method: "spawn",
            }),
          );
        });
        // When
        const result = yield* stillRuns(
          process.pid,
          "Thu Jan  1 00:00:00 1970",
        ).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, noPs),
          Effect.provideService(FileSystem.FileSystem, nodeFs),
        );
        // Then
        const ps = seen[0];
        expect(
          ps?._tag === "StandardCommand"
            ? {
                result,
                command: ps.command,
                args: ps.args,
                env: Object.fromEntries(ps.env),
                extendEnv: ps.extendEnv,
              }
            : { result, command: ps?._tag },
        ).toEqual({
          result: true,
          command: "/bin/ps",
          args: ["-o", "lstart=", "-p", String(process.pid)],
          env: { LC_ALL: "C" },
          extendEnv: false,
        });
      }),
  );
});
