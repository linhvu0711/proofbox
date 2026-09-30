import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Namespace sign-in", () => {
  it("only namespace-signin.ts makes the private sign-in calls", async () => {
    // Given: every .ts file under src/
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          files.push(path);
        }
      }
    };
    walk(join(repoRoot, "src"));
    // When
    const holding = files
      .filter((file) => readFileSync(file, "utf8").includes("nsl.signin."))
      .map((file) => file.slice(repoRoot.length));
    const kinds = new Set(
      Object.values(await import("../src/namespace/namespace-signin.ts")).map(
        (value) => typeof value,
      ),
    );
    // Then
    expect(holding).toEqual(["src/namespace/namespace-signin.ts"]);
    expect([...kinds].sort()).toEqual(["function"]);
  });
});
