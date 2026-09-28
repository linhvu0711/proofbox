import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Recording and the Proof video", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  it("mark refuses a label over 60 characters", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const label = "a".repeat(61);
    // When
    const result = await runCli(env, ["mark", id, label]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Bad Step mark "${label}": use 1 to 60 characters on one line, for example "step 3: save the post"\n`,
    );
  });
});
