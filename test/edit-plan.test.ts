import { describe, expect, it } from "vitest";
import { planEdit } from "../src/proof/edit-plan.ts";

describe("edit-plan", () => {
  it("a Recording with no Step marks is one step with no caption", () => {
    // Given
    const input = { duration: 8, freezes: [], marks: [], clicks: [] };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 8, step: 0 },
      { kind: "still", at: 8, seconds: 2, step: 0 },
    ]);
    expect(plan.captions).toEqual([]);
    expect(plan.seconds).toBe(10);
  });
});
