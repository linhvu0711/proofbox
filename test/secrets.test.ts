import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSecrets } from "../src/secrets.ts";

describe("Secrets", () => {
  it("withSecrets keeps a Secret out of an xtrace log", () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "proofbox-secrets-"));
    try {
      const file = join(dir, "env");
      writeFileSync(file, "export API_TOKEN='pb-secret-7f3a91'\n", {
        mode: 0o600,
      });
      const argv = withSecrets(file, ["sh", "-c", 'printf %s "$API_TOKEN"']);
      // When
      const run = spawnSync("sh", ["-x", ...argv.slice(1)], {
        encoding: "utf8",
      });
      // Then
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("pb-secret-7f3a91");
      expect(run.stderr).not.toContain("pb-secret-7f3a91");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
