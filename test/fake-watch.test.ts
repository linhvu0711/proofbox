import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fake watcher", () => {
  afterEach(cleanupEnvs);

  it("the fake deletes a Sandbox at its Deadline with no Caller", async () => {
    // Given: a Sandbox with a 2-second idle deadline; the create CLI has exited
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--idle",
      "2s",
    ]);
    const id = created.stdout.trim();
    const dir = join(env.root, id.slice("fake:".length));
    // When: poll every 200 ms, up to 8 s
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(200);
      gone = !existsSync(dir);
    }
    // Then
    expect(gone).toBe(true);
    const result = await runCli(env, ["exec", id, "--", "true"]);
    expect(result.stderr).toBe(`Sandbox ${id} is gone\n`);
    expect(result.exitCode).toBe(125);
  });
});
