import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.ts";
import type { WorkFile } from "../src/upload/work-files.ts";

const file = (path: string, sha256: string): WorkFile => ({
  path,
  size: 1,
  sha256,
  executable: false,
});

const script = new TextEncoder().encode("#!/bin/sh\npnpm install\n");
const files = [
  file("pnpm-lock.yaml", "11"),
  file("apps/web/yarn.lock", "22"),
  file("src/a.ts", "33"),
];

describe("fingerprint", () => {
  it("the Fingerprint hashes the Base image version, the Setup script, and every lockfile", () => {
    // Given
    const input = { baseVersion: "v1", script, files };
    // When
    const result = fingerprint(input);
    // Then
    expect(result).toBe("663f532b3197");
  });

  it("a new Base image version gives a new Fingerprint", () => {
    // Given
    const input = { baseVersion: "v2", script, files };
    // When
    const result = fingerprint(input);
    // Then
    expect(result).toBe("05d53d4ef961");
  });

  it("a changed Setup script gives a new Fingerprint", () => {
    // Given
    const other = new TextEncoder().encode(
      "#!/bin/sh\npnpm install --frozen-lockfile\n",
    );
    // When
    const result = fingerprint({ baseVersion: "v1", script: other, files });
    // Then
    expect(result).toBe("346c654636c5");
  });

  it("a changed lockfile in a sub-folder gives a new Fingerprint", () => {
    // Given
    const changed = [
      file("pnpm-lock.yaml", "11"),
      file("apps/web/yarn.lock", "23"),
      file("src/a.ts", "33"),
    ];
    // When
    const result = fingerprint({ baseVersion: "v1", script, files: changed });
    // Then
    expect(result).toBe("51efe317b8c6");
  });

  it("a changed source file or file order keeps the Fingerprint", () => {
    // Given: a source file's hash changes, and the files come in reverse order
    const changed = [
      file("pnpm-lock.yaml", "11"),
      file("apps/web/yarn.lock", "22"),
      file("src/a.ts", "34"),
    ];
    const reversed = [...files].reverse();
    // When
    const first = fingerprint({ baseVersion: "v1", script, files: changed });
    const second = fingerprint({ baseVersion: "v1", script, files: reversed });
    // Then
    expect(first).toBe("663f532b3197");
    expect(second).toBe("663f532b3197");
  });
});
