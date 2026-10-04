import {
  chmodSync,
  existsSync,
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
import { Chunk, Effect, Fiber, Stream, TestClock } from "effect";
import { afterEach, describe, expect } from "vitest";
import {
  CHECKS_START,
  type ChecksShell,
  checksTrailer,
  pushFailedTrailer,
  runCommand,
} from "../src/command-checks.ts";
import { commandEvents } from "../src/command-events.ts";
import { ProviderError, SandboxGoneError } from "../src/errors.ts";
import {
  type Connection,
  type ExecEvent,
  SandboxInfo,
} from "../src/provider.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const bytes = (text: string) => new TextEncoder().encode(text);
const out = (text: string): ExecEvent => ({
  _tag: "Stdout",
  bytes: bytes(text),
});
const err = (text: string): ExecEvent => ({
  _tag: "Stderr",
  bytes: bytes(text),
});
const exit = (code: number): ExecEvent => ({ _tag: "Exit", code });

const fail = (reason: string) =>
  new ProviderError({ provider: "fake", reason });
const gone = () => new SandboxGoneError({ id: "fake:abc123" });

const infoWith = (maxLifeAt: Date) =>
  new SandboxInfo({
    name: "abc123",
    os: "linux",
    createdAt: new Date(0),
    idleSeconds: 900,
    deadline: new Date(900_000),
    maxLifeAt,
  });

// The events of a command run, with each chunk's bytes as text.
const collect = (events: Stream.Stream<ExecEvent, unknown>) =>
  events.pipe(
    Stream.runCollect,
    Effect.map((collected) =>
      Chunk.toReadonlyArray(collected).map((event) =>
        event._tag === "Exit"
          ? event
          : { _tag: event._tag, text: new TextDecoder().decode(event.bytes) },
      ),
    ),
  );

// A Sandbox in a temp folder on this machine: its checks shell appends each
// pushed Deadline to `pushes` and reads the kill count from `kills`, and a
// `date` on its PATH prints 1000, so the Sandbox clock reads 1000.
const localSandbox = (
  options: { readonly maxLifeAt?: Date; readonly push?: string } = {},
) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const dir = mkdtempSync(join(tmpdir(), "proofbox-checks-"));
    tempRoots.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "date"), "#!/bin/sh\necho 1000\n");
    chmodSync(join(dir, "bin", "date"), 0o755);
    const info = infoWith(options.maxLifeAt ?? new Date(10_800_000));
    const extended: Array<string> = [];
    const shell: ChecksShell = {
      push: options.push ?? "printf '%s\\n' \"$d\" >> pushes",
      kills: "cat kills",
      run: '"$@"',
    };
    const connection: Connection = {
      info,
      get: Effect.succeed(info),
      extend: (deadline) =>
        Effect.sync(() => {
          extended.push(deadline.toISOString());
        }),
      transport: {
        shell,
        call: (argv, callOptions) =>
          commandEvents(
            executor,
            Command.make(argv[0] ?? "sh", ...argv.slice(1)).pipe(
              Command.workingDirectory(dir),
              Command.env({ PATH: `${join(dir, "bin")}:${process.env.PATH}` }),
            ),
            callOptions,
            {
              spawn: (error) => fail(error.message),
              fail: (reason) => fail(reason),
            },
          ),
        gone: () => gone(),
        fail: (reason) => fail(reason),
      },
    };
    return { connection, dir, extended };
  });

// A Sandbox whose transport gives these events, whatever it is asked to
// run; `extend` records each running push, or fails as given.
const scriptedSandbox = (
  events: Stream.Stream<ExecEvent>,
  extend?: (deadline: Date) => Effect.Effect<void, ProviderError>,
) => {
  const info = infoWith(new Date(10_800_000));
  const extended: Array<string> = [];
  const connection: Connection = {
    info,
    get: Effect.succeed(info),
    extend:
      extend ??
      ((deadline) =>
        Effect.sync(() => {
          extended.push(deadline.toISOString());
        })),
    transport: {
      shell: { push: ":", kills: "echo 0", run: '"$@"' },
      call: () => events,
      gone: () => gone(),
      fail: (reason) => fail(reason),
    },
  };
  return { connection, extended };
};

// A command that runs for 11 minutes on the test clock.
const longRun = Stream.fromEffect(
  Effect.as(Effect.sleep("11 minutes"), exit(0)),
);

describe("command run", () => {
  it.effect(
    "a command pushes the Deadline by the idle time before and after it",
    () =>
      Effect.gen(function* () {
        // Given
        const sandbox = yield* localSandbox();
        // When
        yield* Stream.runDrain(runCommand(sandbox.connection, ["true"]));
        // Then
        expect(readFileSync(join(sandbox.dir, "pushes"), "utf8")).toBe(
          "1900\n1900\n",
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a command never pushes the Deadline past Max life", () =>
    Effect.gen(function* () {
      // Given: Max life 60 s from now
      const sandbox = yield* localSandbox({ maxLifeAt: new Date(60_000) });
      // When
      yield* Stream.runDrain(runCommand(sandbox.connection, ["true"]));
      // Then
      expect(readFileSync(join(sandbox.dir, "pushes"), "utf8")).toBe(
        "1060\n1060\n",
      );
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect(
    "a command's output and exit code pass through, with the kill counts on Exit",
    () =>
      Effect.gen(function* () {
        // Given
        const sandbox = yield* localSandbox();
        // When
        const events = yield* collect(
          runCommand(sandbox.connection, [
            "sh",
            "-c",
            "printf out; printf err >&2; exit 3",
          ]),
        );
        // Then
        const text = (tag: string) =>
          events
            .flatMap((event) =>
              event._tag === tag && "text" in event ? [event.text] : [],
            )
            .join("");
        expect({
          stdout: text("Stdout"),
          stderr: text("Stderr"),
          exit: events[events.length - 1],
        }).toEqual({
          stdout: "out",
          stderr: "err",
          exit: { _tag: "Exit", code: 3, kills: { before: 0, after: 0 } },
        });
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a memory kill during the command lands on its Exit", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = yield* localSandbox();
      // When: the command raises the kill count
      const events = yield* collect(
        runCommand(sandbox.connection, ["sh", "-c", "echo 1 > kills"]),
      );
      // Then
      expect(events[events.length - 1]).toEqual({
        _tag: "Exit",
        code: 0,
        kills: { before: 0, after: 1 },
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a failed Deadline push before the command stops it", () =>
    Effect.gen(function* () {
      // Given: a push that fails
      const sandbox = yield* localSandbox({
        push: 'echo "disk full" >&2; false',
      });
      // When
      const error = yield* Stream.runDrain(
        runCommand(sandbox.connection, ["touch", "ran"]),
      ).pipe(Effect.flip);
      // Then: the command never ran
      expect({
        message: error.message,
        ran: existsSync(join(sandbox.dir, "ran")),
      }).toEqual({
        message:
          "Provider fake failed: could not write the Deadline: disk full",
        ran: false,
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a failed Deadline push after the command ends the run", () =>
    Effect.gen(function* () {
      // Given: the first push writes, the second fails
      const sandbox = yield* localSandbox({
        push: 'if [ -e pushed ]; then echo "disk full" >&2; false; else : > pushed; fi',
      });
      // When
      const stdout: Array<string> = [];
      const error = yield* Stream.runForEach(
        runCommand(sandbox.connection, ["printf", "out"]),
        (event) =>
          Effect.sync(() => {
            if (event._tag === "Stdout") {
              stdout.push(new TextDecoder().decode(event.bytes));
            }
          }),
      ).pipe(Effect.flip);
      // Then
      expect({ stdout: stdout.join(""), message: error.message }).toEqual({
        stdout: "out",
        message:
          "Provider fake failed: could not write the Deadline: disk full",
      });
    }).pipe(Effect.provide(NodeContext.layer)),
  );

  it.effect("a trailer split over two chunks is still cut", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = scriptedSandbox(
        Stream.make(
          err(CHECKS_START),
          err(`err${checksTrailer(0, 1).slice(0, 8)}`),
          err(checksTrailer(0, 1).slice(8)),
          exit(0),
        ),
      );
      // When
      const events = yield* collect(runCommand(sandbox.connection, ["true"]));
      // Then
      expect(events).toEqual([
        { _tag: "Stderr", text: "err" },
        { _tag: "Exit", code: 0, kills: { before: 0, after: 1 } },
      ]);
    }),
  );

  it.effect(
    "Docker's no such container before the start mark is a gone Sandbox",
    () =>
      Effect.gen(function* () {
        // Given
        const sandbox = scriptedSandbox(
          Stream.make(
            err(
              "Error response from daemon: No such container: proofbox-abc123\n",
            ),
            exit(1),
          ),
        );
        // When
        const error = yield* Stream.runDrain(
          runCommand(sandbox.connection, ["true"]),
        ).pipe(Effect.flip);
        // Then
        expect({ tag: error._tag, message: error.message }).toEqual({
          tag: "SandboxGoneError",
          message: "Sandbox fake:abc123 is gone",
        });
      }),
  );

  it.effect("a runtime warning before the start mark reaches the Caller", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = scriptedSandbox(
        Stream.make(
          err(`warning: x\n${CHECKS_START.slice(0, 5)}`),
          err(CHECKS_START.slice(5) + checksTrailer(0, 0)),
          exit(0),
        ),
      );
      // When
      const events = yield* collect(runCommand(sandbox.connection, ["true"]));
      // Then
      expect(events).toEqual([
        { _tag: "Stderr", text: "warning: x\n" },
        { _tag: "Exit", code: 0, kills: { before: 0, after: 0 } },
      ]);
    }),
  );

  it.effect("other text before the start mark passes through", () =>
    Effect.gen(function* () {
      // Given
      const sandbox = scriptedSandbox(
        Stream.make(err("sh: not found\n"), exit(126)),
      );
      // When
      const events = yield* collect(runCommand(sandbox.connection, ["true"]));
      // Then
      expect(events).toEqual([
        { _tag: "Stderr", text: "sh: not found\n" },
        { _tag: "Exit", code: 126 },
      ]);
    }),
  );

  it.effect(
    "a fail trailer split over chunks fails with the push's own error",
    () =>
      Effect.gen(function* () {
        // Given
        const trailer = pushFailedTrailer("mv: cannot move");
        const sandbox = scriptedSandbox(
          Stream.make(
            err(CHECKS_START),
            err(trailer.slice(0, 6)),
            err(trailer.slice(6)),
            exit(1),
          ),
        );
        // When
        const error = yield* Stream.runDrain(
          runCommand(sandbox.connection, ["true"]),
        ).pipe(Effect.flip);
        // Then
        expect(error.message).toBe(
          "Provider fake failed: could not write the Deadline: mv: cannot move",
        );
      }),
  );

  it.effect(
    "a long command pushes the Deadline every third of the idle time",
    () =>
      Effect.gen(function* () {
        // Given: a command that runs 11 minutes
        const sandbox = scriptedSandbox(longRun);
        // When
        yield* Effect.fork(
          Stream.runDrain(runCommand(sandbox.connection, ["true"])),
        );
        yield* TestClock.adjust("10 minutes");
        // Then
        expect(sandbox.extended).toEqual([
          "1970-01-01T00:20:00.000Z",
          "1970-01-01T00:25:00.000Z",
        ]);
      }),
  );

  it.effect("an interrupted command stops its running push", () =>
    Effect.gen(function* () {
      // Given: a command that runs 11 minutes
      const sandbox = scriptedSandbox(longRun);
      const running = yield* Effect.fork(
        Stream.runDrain(runCommand(sandbox.connection, ["true"])),
      );
      // When: the Caller leaves
      yield* Fiber.interrupt(running);
      yield* TestClock.adjust("20 minutes");
      // Then
      expect(sandbox.extended).toEqual([]);
    }),
  );

  it.effect("a failed running push ends the command", () =>
    Effect.gen(function* () {
      // Given: a command that runs 11 minutes, and a push that fails
      const sandbox = scriptedSandbox(longRun, () =>
        Effect.fail(fail("disk full")),
      );
      // When
      const running = yield* Effect.fork(
        Stream.runDrain(runCommand(sandbox.connection, ["true"])).pipe(
          Effect.flip,
        ),
      );
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(running);
      // Then
      expect(error.message).toBe("Provider fake failed: disk full");
    }),
  );

  it.effect(
    "a command pushes the host's life before it and after its exit",
    () =>
      Effect.gen(function* () {
        // Given: a transport that logs each host push and the command itself
        const log: Array<string> = [];
        const info = infoWith(new Date(10_800_000));
        const connection: Connection = {
          info,
          get: Effect.succeed(info),
          extend: () => Effect.void,
          transport: {
            shell: { push: ":", kills: "echo 0", run: '"$@"' },
            call: () =>
              Stream.concat(
                Stream.execute(Effect.sync(() => log.push("command"))),
                Stream.make(
                  err(CHECKS_START),
                  err(checksTrailer(0, 0)),
                  exit(0),
                ),
              ),
            gone: () => gone(),
            fail: (reason) => fail(reason),
            pushHost: (deadline) =>
              Effect.sync(() => {
                log.push(`host ${deadline.toISOString()}`);
              }),
          },
        };
        // When
        yield* Stream.runDrain(runCommand(connection, ["true"]));
        // Then
        expect(log).toEqual([
          "host 1970-01-01T00:15:00.000Z",
          "command",
          "host 1970-01-01T00:15:00.000Z",
        ]);
      }),
  );

  it.effect("a connection that runs its own checks keeps its events", () =>
    Effect.gen(function* () {
      // Given: the Namespace stand-in shape, with its own exec
      const info = infoWith(new Date(10_800_000));
      const done: ExecEvent = {
        _tag: "Exit",
        code: 0,
        kills: { before: 1, after: 1 },
      };
      const connection: Connection = {
        info,
        get: Effect.succeed(info),
        extend: () => Effect.void,
        exec: () => Stream.make(out("hi\n"), done),
      };
      // When
      const events = yield* collect(runCommand(connection, ["true"]));
      // Then
      expect(events).toEqual([
        { _tag: "Stdout", text: "hi\n" },
        { _tag: "Exit", code: 0, kills: { before: 1, after: 1 } },
      ]);
    }),
  );
});
