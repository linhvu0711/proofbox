import { it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Ref, TestClock } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { Progress } from "../src/progress.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Progress", () => {
  afterEach(cleanupEnvs);

  it.effect("a slow step prints a still line every 15 s", () =>
    Effect.gen(function* () {
      // Given
      const progress = yield* Progress;
      const fiber = yield* Effect.fork(
        progress.step("booting", Effect.sleep("40 seconds")),
      );
      // When
      yield* TestClock.adjust("40 seconds");
      yield* Fiber.join(fiber);
      const output = yield* CliOutput;
      const err = Chunk.toReadonlyArray(
        yield* Ref.get(output.captured.err),
      ).join("");
      // Then
      expect(err).toBe(
        "proofbox: booting\nproofbox: still booting (15 s)\nproofbox: still booting (30 s)\n",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
    ),
  );

  it("create prints progress lines on stderr and only the id on stdout", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    // Then
    expect(result.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\n",
    );
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.exitCode).toBe(0);
  });
});
