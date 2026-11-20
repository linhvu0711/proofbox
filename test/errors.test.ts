import { describe, expect, it } from "vitest";
import { causeText, localFailure } from "../src/errors.ts";

describe("errors", () => {
  it("causeText gives an Error's message", () => {
    // Given: nothing
    // When
    const text = causeText(new Error("disk full"));
    // Then
    expect(text).toBe("disk full");
  });

  it("causeText gives any other value as text", () => {
    // Given: nothing
    // When
    const text = causeText(42);
    // Then
    expect(text).toBe("42");
  });

  it("localFailure names the local Provider and the cause", () => {
    // Given: nothing
    // When
    const message = localFailure(new Error("disk full")).message;
    // Then
    expect(message).toBe("Provider local failed: disk full");
  });
});
