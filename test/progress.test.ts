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

  it.effect("Ctrl-C during a live line clears it", () => {
    const terminal = CliOutput.TestTerminal(80);
    return Effect.gen(function* () {
      const progress = yield* Progress;
      const fiber = yield* Effect.fork(
        progress.step("booting", Effect.sleep("40 seconds")),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(fiber);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).at(-1),
      ).toBe("\r\u001b[2K");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminal,
          Progress.Default.pipe(Layer.provide(terminal)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
      ),
    );
  });

  it.effect(
    "on a terminal a running step is one live line with a spinner and a timer",
    () => {
      const terminal = CliOutput.TestTerminal(80);
      return Effect.gen(function* () {
        const progress = yield* Progress;
        const fiber = yield* Effect.fork(
          progress.step("booting", Effect.sleep("40 seconds")),
        );
        yield* TestClock.adjust("40 seconds");
        yield* Fiber.join(fiber);
        const output = yield* CliOutput;
        const chunks = Chunk.toReadonlyArray(
          yield* Ref.get(output.captured.err),
        );
        expect(chunks[0]).toBe("\r\u001b[2K⠋ booting  0s");
        expect(chunks.at(-1)).toBe("\r\u001b[2K✔ booting  40s\n");
        expect(chunks.some((chunk) => chunk.includes("still"))).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            terminal,
            Progress.Default.pipe(Layer.provide(terminal)),
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
        ),
      );
    },
  );

  it.effect("a warning during a live step prints above the live line", () => {
    const terminal = CliOutput.TestTerminal(80);
    return Effect.gen(function* () {
      const progress = yield* Progress;
      const fiber = yield* Effect.fork(
        progress.step(
          "booting",
          Effect.sleep("1 second").pipe(
            Effect.zipRight(progress.warn("disk is slow")),
            Effect.zipRight(Effect.sleep("1 second")),
          ),
        ),
      );
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)),
      ).toContain("\r\u001b[2K! disk is slow\n\r\u001b[2K⠹ booting  1s");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminal,
          Progress.Default.pipe(Layer.provide(terminal)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
      ),
    );
  });

  it.effect("a failed live step prints ✘", () => {
    const terminal = CliOutput.TestTerminal(80);
    return Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress.step("booting", Effect.fail("no")).pipe(Effect.flip);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).at(-1),
      ).toBe("\r\u001b[2K✘ booting\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminal,
          Progress.Default.pipe(Layer.provide(terminal)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
      ),
    );
  });

  it.effect("a live line wider than the terminal is cut with …", () => {
    const terminal = CliOutput.TestTerminal(20);
    return Effect.gen(function* () {
      const progress = yield* Progress;
      const fiber = yield* Effect.fork(
        progress.step("creating fake Sandbox", Effect.sleep("1 second")),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err))[0],
      ).toBe("\r\u001b[2K⠋ creating fak…  0s");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminal,
          Progress.Default.pipe(Layer.provide(terminal)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
      ),
    );
  });

  it.effect("a live line uses the current terminal width after a resize", () =>
    Effect.gen(function* () {
      const columns = yield* Ref.make(80);
      const terminal = CliOutput.TestTerminal(Ref.get(columns));
      yield* Effect.gen(function* () {
        const progress = yield* Progress;
        const fiber = yield* Effect.fork(
          progress.step("creating fake Sandbox", Effect.sleep("1 second")),
        );
        yield* TestClock.adjust("0 millis");
        const output = yield* CliOutput;
        expect(
          Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).at(-1),
        ).toBe("\r\u001b[2K⠋ creating fake Sandbox  0s");
        yield* Ref.set(columns, 20);
        yield* TestClock.adjust("80 millis");
        expect(
          Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).at(-1),
        ).toBe("\r\u001b[2K⠙ creating fak…  0s");
        yield* Fiber.interrupt(fiber);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            terminal,
            Progress.Default.pipe(Layer.provide(terminal)),
          ),
        ),
      );
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["NO_COLOR", "1"]])),
      ),
    ),
  );

  it.effect("with FORCE_COLOR=1 a note prints dim with two spaces", () =>
    Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress.note("Snapshot saved, Fingerprint abc");
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).toBe("\u001b[2m  Snapshot saved, Fingerprint abc\u001b[0m\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["FORCE_COLOR", "1"]])),
      ),
    ),
  );

  it.effect("with FORCE_COLOR=1 a warning prints a yellow !", () =>
    Effect.gen(function* () {
      const progress = yield* Progress;
      yield* progress.warn("disk is slow");
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).toBe("\u001b[33m!\u001b[0m disk is slow\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Progress.Default.pipe(Layer.provide(CliOutput.Test)),
        ),
      ),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["FORCE_COLOR", "1"]])),
      ),
    ),
  );

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
