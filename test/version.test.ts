import { describe, expect, it } from "vitest";
import { versionText } from "../src/version.ts";

describe("version", () => {
  it("with a commit, the version names it", () => {
    // Given: nothing
    // When
    const text = versionText("b49452f");
    // Then
    expect(text).toBe("0.0.0 (b49452f)");
  });
});
