#!/usr/bin/env node
import { ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Exit, Layer } from "effect";
import { cli } from "./cli.ts";
import { CliOutput } from "./cli-output.ts";
import { ProvidersLive } from "./fake/fake-provider.ts";

const program = Effect.gen(function* () {
  const output = yield* CliOutput;
  yield* cli(process.argv).pipe(
    Effect.catchAll((error) =>
      (ValidationError.isValidationError(error)
        ? Effect.void
        : output.err(`${error.message}\n`)
      ).pipe(Effect.zipRight(output.setExitCode(125))),
    ),
  );
  return yield* output.exitCode;
}).pipe(
  Effect.provide(
    Layer.mergeAll(NodeContext.layer, CliOutput.Default, ProvidersLive),
  ),
);

NodeRuntime.runMain(program, {
  teardown: (exit, onExit) =>
    onExit(
      Exit.isSuccess(exit) && typeof exit.value === "number" ? exit.value : 125,
    ),
});
