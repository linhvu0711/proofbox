import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("Help text", () => {
  afterEach(cleanupEnvs);

  it("proofbox --help shows the app description", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["--help"]);
    // Then
    expect(result.stdout).toContain(
      "rent a disposable Sandbox, drive its screen, and bring back a Proof video",
    );
  });
});
