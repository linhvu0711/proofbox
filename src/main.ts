#!/usr/bin/env -S node --
import { ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Exit, Layer } from "effect";
import { cli } from "./cli.ts";
import { CliOutput } from "./cli-output.ts";
import { execInSandbox } from "./commands/exec.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { Progress } from "./progress.ts";
import { ProvidersLive } from "./provider-registry.ts";

// @effect/cli matches its built-in `--help` anywhere in argv, even after
// `--`, so `exec` with a passthrough argv is dispatched by hand.
const dispatch = (argv: ReadonlyArray<string>) => {
  if (argv[2] === "exec") {
    const separator = argv.indexOf("--", 3);
    if (separator > 3 && separator < argv.length - 1) {
      return execInSandbox(argv[3] as string, argv.slice(separator + 1));
    }
  }
  return cli(argv);
};

const providersLive = ProvidersLive.pipe(Layer.provide(NodeContext.layer));

const program = Effect.gen(function* () {
  const output = yield* CliOutput;
  yield* dispatch(process.argv).pipe(
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
    Layer.mergeAll(
      NodeContext.layer,
      CliOutput.Default,
      providersLive,
      KeeperClient.Default.pipe(
        Layer.provide(Layer.mergeAll(CliOutput.Default, providersLive)),
      ),
      Progress.Default.pipe(Layer.provide(CliOutput.Default)),
    ),
  ),
);

NodeRuntime.runMain(program, {
  teardown: (exit, onExit) =>
    onExit(
      Exit.isSuccess(exit) && typeof exit.value === "number" ? exit.value : 125,
    ),
});
