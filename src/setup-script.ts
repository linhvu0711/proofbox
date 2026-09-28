import { posix } from "node:path";
import { Effect, Stream } from "effect";
import { CliOutput } from "./cli-output.ts";
import { withDeadlinePush } from "./deadline.ts";
import { SetupScriptFailedError, UploadFailedError } from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { parseSandboxId } from "./sandbox-id.ts";

const KEEP_LINES = 50;

export const runSetupScript = (rawId: string, script: Uint8Array) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    const info = yield* provider.get(id.name);
    const progress = yield* Progress;
    const keeper = yield* KeeperClient;
    const setupPath = posix.join(provider.stateDir(id.name), "setup");
    const result = yield* progress.step(
      "running Setup script",
      withDeadlinePush(
        provider,
        id.name,
        info,
      )(
        Effect.gen(function* () {
          const written = yield* keeper.exec(
            rawId,
            [
              "sh",
              "-c",
              'umask 077; cat > "$1" && chmod 700 "$1"',
              "sh",
              setupPath,
            ],
            { stdin: Stream.make(script) },
          );
          let writeCode = 0;
          yield* written.pipe(
            Stream.runForEach((event) =>
              event._tag === "Exit"
                ? Effect.sync(() => {
                    writeCode = event.code;
                  })
                : Effect.void,
            ),
          );
          if (writeCode !== 0) {
            return yield* new UploadFailedError({
              id: rawId,
              command: "sh",
              code: writeCode,
            });
          }
          const lines: Array<string> = [];
          let pending = "";
          const decoder = new TextDecoder();
          const keep = (chunk: Uint8Array) => {
            pending += decoder.decode(chunk, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
              lines.push(pending.slice(0, newline + 1));
              if (lines.length > KEEP_LINES) {
                lines.shift();
              }
              pending = pending.slice(newline + 1);
              newline = pending.indexOf("\n");
            }
            // A runaway line would grow the Caller without end; the tail
            // is all "last 50 lines" needs anyway. Clip only the unflushed
            // remainder so complete lines are never dropped mid-chunk.
            if (pending.length > 65_536) {
              pending = pending.slice(-65_536);
            }
          };
          const ran = yield* keeper.exec(rawId, [setupPath]);
          let code = 0;
          yield* ran.pipe(
            Stream.runForEach((event) => {
              switch (event._tag) {
                case "Stdout":
                case "Stderr":
                  return Effect.sync(() => keep(event.bytes));
                case "Exit":
                  return Effect.sync(() => {
                    code = event.code;
                  });
              }
            }),
          );
          pending += decoder.decode();
          if (pending !== "") {
            lines.push(`${pending}\n`);
            if (lines.length > KEEP_LINES) {
              lines.shift();
            }
          }
          return { code, lines } as const;
        }),
      ),
    );
    if (result.code !== 0) {
      const output = yield* CliOutput;
      for (const line of result.lines) {
        yield* output.err(line);
      }
      yield* provider.delete(id.name);
      yield* keeper.stop(rawId);
      return yield* new SetupScriptFailedError({ code: result.code });
    }
  });
