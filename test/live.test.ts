import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

describe("live", () => {
  afterEach(cleanupEnvs);

  it("live on a Provider with no Live view is refused", async () => {
    // Given: a fake Sandbox — fake offers no Live view
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["live", id]);
    // Then
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability live-view; no Live view was opened\n",
    );
    expect(result.exitCode).toBe(125);
  });
});
