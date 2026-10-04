import { Chunk, Effect, Layer, Ref } from "effect";

const decoder = new TextDecoder();
const asText = (data: string | Uint8Array) =>
  typeof data === "string" ? data : decoder.decode(data);

interface CliOutputShape {
  readonly out: (data: string | Uint8Array) => Effect.Effect<void>;
  readonly err: (data: string | Uint8Array) => Effect.Effect<void>;
  readonly setExitCode: (code: number) => Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
  readonly captured: {
    readonly out: Ref.Ref<Chunk.Chunk<string>>;
    readonly err: Ref.Ref<Chunk.Chunk<string>>;
    readonly exitCode: Ref.Ref<number>;
  };
}

const makeCaptured = Effect.all({
  out: Ref.make(Chunk.empty<string>()),
  err: Ref.make(Chunk.empty<string>()),
  exitCode: Ref.make(0),
});

export class CliOutput extends Effect.Service<CliOutput>()(
  "proofbox/CliOutput",
  {
    effect: Effect.gen(function* () {
      const captured = yield* makeCaptured;
      const write = (
        stream: NodeJS.WriteStream,
        ref: Ref.Ref<Chunk.Chunk<string>>,
        data: string | Uint8Array,
      ) =>
        Ref.update(ref, Chunk.append(asText(data))).pipe(
          Effect.zipRight(
            Effect.async<void>((resume) => {
              stream.write(data, () => resume(Effect.void));
            }),
          ),
        );
      return {
        out: Effect.fn("CliOutput.out")((data: string | Uint8Array) =>
          write(process.stdout, captured.out, data),
        ),
        err: Effect.fn("CliOutput.err")((data: string | Uint8Array) =>
          write(process.stderr, captured.err, data),
        ),
        setExitCode: Effect.fn("CliOutput.setExitCode")((code: number) =>
          Ref.set(captured.exitCode, code),
        ),
        exitCode: Ref.get(captured.exitCode),
        captured,
      } satisfies CliOutputShape;
    }),
  },
) {
  static Test = Layer.effect(
    CliOutput,
    Effect.map(
      makeCaptured,
      (captured) =>
        new CliOutput({
          out: (data) => Ref.update(captured.out, Chunk.append(asText(data))),
          err: (data) => Ref.update(captured.err, Chunk.append(asText(data))),
          setExitCode: (code) => Ref.set(captured.exitCode, code),
          exitCode: Ref.get(captured.exitCode),
          captured,
        }),
    ),
  );
}
