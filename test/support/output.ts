import { Chunk, Context, Effect, Layer, Ref } from "effect";
import { CliOutput } from "../../src/cli-output.ts";

// What a test layer's CliOutput wrote, one entry per write.
export class CapturedOutput extends Context.Tag("proofbox/CapturedOutput")<
  CapturedOutput,
  {
    readonly out: Ref.Ref<Chunk.Chunk<string>>;
    readonly err: Ref.Ref<Chunk.Chunk<string>>;
  }
>() {}

const decoder = new TextDecoder();
const asText = (data: string | Uint8Array) =>
  typeof data === "string" ? data : decoder.decode(data);

const capturing = (terminal: CliOutput["terminal"]) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const out = yield* Ref.make(Chunk.empty<string>());
      const err = yield* Ref.make(Chunk.empty<string>());
      const exitCode = yield* Ref.make(0);
      return Context.make(
        CliOutput,
        new CliOutput({
          terminal,
          out: (data) => Ref.update(out, Chunk.append(asText(data))),
          err: (data) => Ref.update(err, Chunk.append(asText(data))),
          setExitCode: (code) => Ref.set(exitCode, code),
          exitCode: Ref.get(exitCode),
        }),
      ).pipe(Context.add(CapturedOutput, { out, err }));
    }),
  );

// A CliOutput with no terminal that keeps every write for the test to read.
export const testOutput = capturing({
  // biome-ignore lint/style/useNamingConvention: matches Node's terminal fact.
  isTTY: false,
  columns: Effect.succeed(0),
});

// The same, on a terminal of the given width.
export const testTerminalOutput = (columns: number | Effect.Effect<number>) =>
  capturing({
    // biome-ignore lint/style/useNamingConvention: matches Node's terminal fact.
    isTTY: true,
    columns: typeof columns === "number" ? Effect.succeed(columns) : columns,
  });
