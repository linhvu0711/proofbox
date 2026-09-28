import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { spawnDetached } from "../src/spawn-detached.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Provider registry", () => {
  it("no file outside src/fake imports from src/fake", () => {
    // Given: every .ts file under src/, minus paths under src/fake/
    const files = readdirSync(join(repoRoot, "src"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `src/${path}`)
      .filter((path) => !path.startsWith("src/fake/"));
    // When
    const offenders = files.filter((path) =>
      /^\s*(import|export)\b[^;]*?\bfrom\s+["'][^"']*\/fake\//m.test(
        readFileSync(join(repoRoot, path), "utf8"),
      ),
    );
    // Then
    expect(offenders).toEqual([]);
  });

  it.effect("spawnDetached errors name the calling Provider", () =>
    Effect.gen(function* () {
      // Given: an arg with a NUL byte, which makes Node's spawn throw at once
      // When
      const error = yield* Effect.flip(
        spawnDetached("docker", "keeper/keeper-main", ["bad\u0000arg"]),
      );
      // Then
      expect(error.provider).toBe("docker");
      expect(error.message).toMatch(/^Provider docker failed: /);
    }),
  );
});
