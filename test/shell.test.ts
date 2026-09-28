import { describe, expect, it } from "vitest";
import { shellJoin } from "../src/shell.ts";

describe("shellJoin", () => {
  it("shellJoin quotes each arg", () => {
    // Given: argv with spaces and a quote
    const argv = ["printf", "%s|", "a b", "it's"];
    // When
    const joined = shellJoin(argv);
    // Then
    expect(joined).toBe("'printf' '%s|' 'a b' 'it'\\''s'");
  });
});
