import { it } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Ref,
  TestClock,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { Progress } from "../src/progress.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Progress", () => {
  afterEach(cleanupEnvs);

  it("with FORCE_COLOR=1 create prints a ✔ line per step", async () => {
    const env = makeEnv();
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { FORCE_COLOR: "1" } },
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: match the ANSI reset after elapsed time.
    expect(result.stderr.replace(/\d+(m \d+)?s(?=\u001b\[0m\n)/g, "<t>")).toBe(
      "\u001b[32m✔\u001b[0m creating fake Sandbox  \u001b[2m<t>\u001b[0m\n\u001b[32m✔\u001b[0m starting Keeper  \u001b[2m<t>\u001b[0m\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it.effect("with FORCE_COLOR=1 a failed step prints ✘ and its label", () =>
    Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress.step("booting", Effect.fail("no")).pipe(Effect.flip);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).toBe("✘ booting\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["FORCE_COLOR", "1"],
            ["NO_COLOR", "1"],
          ]),
        ),
      ),
    ),
  );

  it.effect(
    "with FORCE_COLOR=1 and no terminal a slow step prints dim still lines",
    () =>
      Effect.gen(function* () {
        const progress = yield* Progress;
        const fiber = yield* Effect.fork(
          progress.step("booting", Effect.sleep("40 seconds")),
        );
        yield* TestClock.adjust("40 seconds");
        yield* Fiber.join(fiber);
        const output = yield* CliOutput;
        expect(
          Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
        ).toBe(
          "  still booting (15 s)\n  still booting (30 s)\n✔ booting  40s\n",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliOutput.Test,
            Progress.Default.pipe(Layer.provide(CliOutput.Test)),
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["FORCE_COLOR", "1"],
              ["NO_COLOR", "1"],
            ]),
          ),
        ),
      ),
  );

  it("NO_COLOR keeps the marks and drops the colors", async () => {
    const env = makeEnv();
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    expect(result.stderr.replace(/ {2}\d+(m \d+)?s\n/g, "  <t>\n")).toBe(
      "✔ creating fake Sandbox  <t>\n✔ starting Keeper  <t>\n",
    );
    expect(result.stderr).not.toContain("\u001b");
  });

  it.effect("an empty NO_COLOR keeps the colors", () =>
    Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress.step("booting", Effect.void);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).toBe("\u001b[32m✔\u001b[0m booting  \u001b[2m0s\u001b[0m\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["FORCE_COLOR", "1"],
            ["NO_COLOR", ""],
          ]),
        ),
      ),
    ),
  );

  it.effect("TERM=dumb on a terminal prints today's lines", () => {
    const terminal = CliOutput.TestTerminal(80);
    return Effect.gen(function* () {
      const progress = yield* Progress;
      const fiber = yield* Effect.fork(
        progress.step("booting", Effect.sleep("40 seconds")),
      );
      yield* TestClock.adjust("40 seconds");
      yield* Fiber.join(fiber);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).toBe(
        "proofbox: booting\nproofbox: still booting (15 s)\nproofbox: still booting (30 s)\n",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminal,
          Progress.Default.pipe(Layer.provide(terminal)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["TERM", "dumb"]])),
      ),
    );
  });

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
