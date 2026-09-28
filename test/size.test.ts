import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { parseSize } from "../src/size.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("--size", () => {
  afterEach(cleanupEnvs);

  it.effect("parseSize reads cpu and ram", () =>
    Effect.gen(function* () {
      // When
      const twoThree = yield* parseSize("2x3");
      const sixteenThirtyTwo = yield* parseSize("16x32");
      const badText = yield* Effect.flip(parseSize("abc"));
      const badZero = yield* Effect.flip(parseSize("0x4"));
      // Then
      expect(twoThree).toEqual({ cpu: 2, ramGb: 3 });
      expect(sixteenThirtyTwo).toEqual({ cpu: 16, ramGb: 32 });
      expect(badText._tag).toBe("BadSizeError");
      expect(badZero._tag).toBe("BadSizeError");
    }),
  );

  it("a bad --size is refused", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--size",
      "abc",
    ]);
    // Then
    expect(result.stderr).toBe(
      'Bad --size "abc": use <cpu>x<ram> in whole numbers, for example 4x8\n',
    );
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
  });

  it("a size the Provider does not offer is refused with the offered sizes", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--size",
      "3x3",
    ]);
    // Then
    expect(result.stderr).toBe(
      "Provider fake does not offer the size 3x3; use one of: 4x8, 8x16, 16x32\n",
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(125);
    expect(readdirSync(env.root)).toEqual([]);
    expect(readdirSync(env.runtime)).toEqual([]);
  });

  it("create --size passes the size to the Provider", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--size",
      "8x16",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const name = result.stdout.trim().slice("fake:".length);
    const file = JSON.parse(
      readFileSync(join(env.root, name, "sandbox.json"), "utf8"),
    ) as { size?: { cpu: number; ramGb: number } };
    expect(file.size).toEqual({ cpu: 8, ramGb: 16 });
  });
});
