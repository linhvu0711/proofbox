import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { Progress } from "../src/progress.ts";

const tempRoots: string[] = [];
const makeRoot = () => {
  const parent = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(parent);
  return join(parent, "root");
};

const noProgress = new Progress({ step: (_label, effect) => effect });

describe("fake Provider", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("create refuses an idle time that is not whole seconds", () =>
    Effect.gen(function* () {
      // Given
      const root = makeRoot();
      const fake = makeFakeProvider({ root, watch: "none" });
      // When
      const error = yield* fake
        .create({
          os: "linux",
          idle: Duration.millis(1500),
          maxLife: Duration.hours(1),
        })
        .pipe(Effect.provideService(Progress, noProgress), Effect.flip);
      // Then: a ProviderError, and no Sandbox folder was made
      expect(error._tag).toBe("ProviderError");
      expect(error.reason).toContain("whole number of seconds");
      expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    }),
  );
});
