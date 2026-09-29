import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.ts";
import type { WorkFile } from "../src/upload/work-files.ts";

const file = (path: string, sha256: string): WorkFile => ({
  path,
  size: 1,
  sha256,
  executable: false,
});

const script = (text: string) => new TextEncoder().encode(text);

const base = {
  baseVersion: "v1",
  script: script("#!/bin/sh\npnpm install\n"),
  files: [
    file("pnpm-lock.yaml", "11"),
    file("apps/web/yarn.lock", "22"),
    file("src/a.ts", "33"),
  ],
};

describe("fingerprint", () => {
  it("the Fingerprint hashes the Base image version, the Setup script, and every lockfile", () => {
    // Given: base
    // When
    const result = fingerprint(base);
    // Then
    expect(result).toBe("663f532b3197");
  });

  it("a new Base image version gives a new Fingerprint", () => {
    // Given
    const input = { ...base, baseVersion: "v2" };
    // When
    const result = fingerprint(input);
    // Then
    expect(result).toBe("05d53d4ef961");
  });

  it("a changed Setup script gives a new Fingerprint", () => {
    // Given
    const input = {
      ...base,
      script: script("#!/bin/sh\npnpm install --frozen-lockfile\n"),
    };
    // When
    const result = fingerprint(input);
    // Then
    expect(result).toBe("346c654636c5");
  });

  it("a changed lockfile in a sub-folder gives a new Fingerprint", () => {
    // Given
    const input = {
      ...base,
      files: [
        file("pnpm-lock.yaml", "11"),
        file("apps/web/yarn.lock", "23"),
        file("src/a.ts", "33"),
      ],
    };
    // When
    const result = fingerprint(input);
    // Then
    expect(result).toBe("51efe317b8c6");
  });

  it("a changed source file or file order keeps the Fingerprint", () => {
    // Given
    const changed = {
      ...base,
      files: [
        file("pnpm-lock.yaml", "11"),
        file("apps/web/yarn.lock", "22"),
        file("src/a.ts", "34"),
      ],
    };
    const reversed = { ...base, files: [...base.files].reverse() };
    // When
    const results = [fingerprint(changed), fingerprint(reversed)];
    // Then
    expect(results).toEqual(["663f532b3197", "663f532b3197"]);
  });
});
