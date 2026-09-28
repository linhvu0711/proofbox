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

  it("each Step mark starts a step that ends on a 2 s hold", () => {
    // Given
    const input = { duration: 20, freezes: [], marks: [2, 10], clicks: [] };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 2, step: 0 },
      { kind: "cut", from: 2, to: 10, step: 1 },
      { kind: "still", at: 10, seconds: 2, step: 1 },
      { kind: "cut", from: 10, to: 20, step: 2 },
      { kind: "still", at: 20, seconds: 2, step: 2 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 2, to: 12 },
      { step: 2, from: 12, to: 24 },
    ]);
    expect(plan.seconds).toBe(24);
  });

  it("a step shorter than 3 s is held until it lasts 3 s", () => {
    // Given
    const input = { duration: 5, freezes: [], marks: [0, 0.5], clicks: [] };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 0.5, step: 1 },
      { kind: "still", at: 0.5, seconds: 2.5, step: 1 },
      { kind: "cut", from: 0.5, to: 5, step: 2 },
      { kind: "still", at: 5, seconds: 2, step: 2 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 0, to: 3 },
      { step: 2, from: 3, to: 9.5 },
    ]);
    expect(plan.seconds).toBe(9.5);
  });
});
