import { Effect, Ref } from "effect";

interface CliOutputShape {
  readonly terminal: {
    // biome-ignore lint/style/useNamingConvention: matches Node's terminal fact.
    readonly isTTY: boolean;
    readonly columns: Effect.Effect<number>;
  };
  readonly out: (data: string | Uint8Array) => Effect.Effect<void>;
  readonly err: (data: string | Uint8Array) => Effect.Effect<void>;
  readonly setExitCode: (code: number) => Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
}

export class CliOutput extends Effect.Service<CliOutput>()(
  "proofbox/CliOutput",
  {
    effect: Effect.gen(function* () {
      const exitCode = yield* Ref.make(0);
      const write = (stream: NodeJS.WriteStream, data: string | Uint8Array) =>
        Effect.async<void>((resume) => {
          stream.write(data, () => resume(Effect.void));
        });
      return {
        terminal: {
          // biome-ignore lint/style/useNamingConvention: matches Node's terminal fact.
          isTTY: process.stderr.isTTY === true,
          columns: Effect.sync(() => process.stderr.columns ?? 0),
        },
        out: Effect.fn("CliOutput.out")((data: string | Uint8Array) =>
          write(process.stdout, data),
        ),
        err: Effect.fn("CliOutput.err")((data: string | Uint8Array) =>
          write(process.stderr, data),
        ),
        setExitCode: Effect.fn("CliOutput.setExitCode")((code: number) =>
          Ref.set(exitCode, code),
        ),
        exitCode: Ref.get(exitCode),
      } satisfies CliOutputShape;
    }),
  },
) {}
