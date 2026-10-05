#!/usr/bin/env -S node --
import { CliConfig, ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Exit, Layer } from "effect";
import { commandWords, makeCli } from "./cli.ts";
import { CliOutput } from "./cli-output.ts";
import { execInSandbox } from "./commands/exec.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { ProvidersLive } from "./provider-registry.ts";
import { Style } from "./style.ts";

// @effect/cli matches its built-in `--help` anywhere in argv, even after
// `--`, so `exec` with a passthrough argv is dispatched by hand.
const dispatch = Effect.fn("main.dispatch")(function* (
  argv: ReadonlyArray<string>,
) {
  if (argv[2] === "exec") {
    const separator = argv.indexOf("--", 3);
    if (separator > 3 && separator < argv.length - 1) {
      return yield* execInSandbox(argv[3] as string, argv.slice(separator + 1));
    }
  }
  const providers = yield* Providers;
  return yield* makeCli([...providers.keys()])(argv);
});

const providersLive = ProvidersLive.pipe(Layer.provide(NodeContext.layer));

const program = Effect.gen(function* () {
  const output = yield* CliOutput;
  const style = yield* Style;
  const defaultConsole = yield* Console.consoleWith(Effect.succeed);
  const providers = yield* Providers;
  const command = commandWords(process.argv.slice(2), [...providers.keys()]);
  const words = command === "" ? "" : `${command} `;
  const parserConsole = {
    ...defaultConsole,
    error: (...args: ReadonlyArray<unknown>) => {
      const text = args.join(" ");
      return output.err(
        style.look
          ? `${style.mark("bad")} ${text.trimEnd()}\n${style.paint("dim", `  see proofbox ${words}--help`)}\n`
          : `${text}\n`,
      );
    },
  };
  yield* dispatch(process.argv).pipe(
    Effect.withConsole(parserConsole),
    Effect.catchAll((error) =>
      (ValidationError.isValidationError(error)
        ? Effect.void
        : output.err(
            style.look
              ? `${style.mark("bad")} ${error.message}\n`
              : `${error.message}\n`,
          )
      ).pipe(Effect.zipRight(output.setExitCode(125))),
    ),
  );
  return yield* output.exitCode;
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeContext.layer,
      CliConfig.layer({ showBuiltIns: false }),
      CliOutput.Default,
      Style.Default.pipe(Layer.provide(CliOutput.Default)),
      providersLive,
      KeeperClient.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            CliOutput.Default,
            providersLive,
            NodeContext.layer,
            Progress.Default.pipe(Layer.provide(CliOutput.Default)),
          ),
        ),
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
