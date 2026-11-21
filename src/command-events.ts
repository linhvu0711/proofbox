import { Command, CommandExecutor } from "@effect/platform";
import { Chunk, Effect, Stream } from "effect";
import { causeText } from "./errors.ts";
import type { ExecEvent, ExecOptions } from "./provider.ts";

// Runs one process and streams it as ExecEvents: stdout and stderr as they
// come, then the exit code. Given stdin is fed until it ends or the process
// exits. With none given the process reads end of input at once, so a
// command that reads stdin cannot wait forever on an open pipe (ssh -T
// forwards one). `exit` may turn an exit code into a failure (ssh's 255).
export const commandEvents = <E>(
  executor: CommandExecutor.CommandExecutor,
  command: Command.Command,
  options: ExecOptions | undefined,
  errors: {
    readonly spawn: (error: {
      readonly _tag: string;
      readonly reason?: unknown;
      readonly message: string;
    }) => E;
    readonly fail: (reason: string) => E;
    readonly exit?: (code: number) => Effect.Effect<number, E>;
  },
): Stream.Stream<ExecEvent, E> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const process = yield* Command.start(
        options?.stdin === undefined
          ? Command.stdin(command, Stream.empty)
          : command,
      ).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.mapError((error) => errors.spawn(error)),
      );
      const feed =
        options?.stdin === undefined
          ? undefined
          : Stream.run(options.stdin, process.stdin).pipe(
              // A command may exit before its stdin reports "finish"
              // (tar -x stops at the end-of-archive marker); when the
              // process is gone the feed is done by definition.
              Effect.raceFirst(
                process.exitCode.pipe(Effect.orElseSucceed(() => {})),
              ),
              Effect.mapError((error) => errors.fail(causeText(error))),
            );
      const outputs = Stream.merge(
        process.stdout.pipe(
          Stream.map((bytes): ExecEvent => ({ _tag: "Stdout", bytes })),
        ),
        process.stderr.pipe(
          Stream.map((bytes): ExecEvent => ({ _tag: "Stderr", bytes })),
        ),
      ).pipe(Stream.mapError((error) => errors.fail(causeText(error))));
      const events =
        feed === undefined
          ? outputs
          : Stream.merge(outputs, Stream.fromEffect(feed).pipe(Stream.drain));
      const exit = Stream.fromEffect(
        process.exitCode.pipe(
          Effect.mapError((error) => errors.fail(causeText(error))),
          Effect.flatMap((code) =>
            errors.exit === undefined
              ? Effect.succeed(code)
              : errors.exit(code),
          ),
          Effect.map((code): ExecEvent => ({ _tag: "Exit", code })),
        ),
      );
      return Stream.concat(events, exit);
    }),
  );

// Collected process output as UTF-8 text.
export const toText = (chunks: Chunk.Chunk<Uint8Array>) =>
  Buffer.concat(Chunk.toReadonlyArray(chunks).map((bytes) => bytes)).toString(
    "utf8",
  );

// One event stream to its end: its exit code, and stdout and stderr as
// text, as captureCommand gives for a process.
export const collectEvents = Effect.fn("commandEvents.collectEvents")(
  function* <E>(events: Stream.Stream<ExecEvent, E>) {
    const collected = yield* Stream.runCollect(events);
    let exitCode = 1;
    const out: Array<Uint8Array> = [];
    const err: Array<Uint8Array> = [];
    for (const event of Chunk.toReadonlyArray(collected)) {
      if (event._tag === "Exit") {
        exitCode = event.code;
      } else if (event._tag === "Stdout") {
        out.push(event.bytes);
      } else {
        err.push(event.bytes);
      }
    }
    return {
      exitCode,
      stdout: toText(Chunk.fromIterable(out)),
      stderr: toText(Chunk.fromIterable(err)),
    };
  },
);

// Runs one short process to its end: its exit code, and stdout and stderr
// as text. Both pipes are read at once, so a full stderr cannot block it.
export const captureCommand = Effect.fn("commandEvents.captureCommand")(
  function* (command: Command.Command) {
    const process = yield* Command.start(command);
    const [outBytes, errBytes, exitCode] = yield* Effect.all(
      [
        Stream.runCollect(process.stdout),
        Stream.runCollect(process.stderr),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return {
      exitCode,
      stdout: toText(outBytes),
      stderr: toText(errBytes),
    };
  },
  Effect.scoped,
);
