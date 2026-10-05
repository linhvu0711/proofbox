import { describe, expect, it } from "vitest";
import { formatClock } from "../src/format-time.ts";

describe("format-time", () => {
  it("formatClock shows a time today as hours and minutes", () => {
    // Given: a time later today, in local time
    const now = new Date(2026, 9, 5, 9, 0);
    const date = new Date(2026, 9, 5, 14, 5, 40);
    // When
    const clock = formatClock(date, now);
    // Then
    expect(clock).toBe("14:05");
  });

  it("formatClock puts the date before a time on another day", () => {
    // Given: a time after midnight, in local time
    const now = new Date(2026, 9, 5, 23, 0);
    const date = new Date(2026, 9, 6, 1, 30);
    // When
    const clock = formatClock(date, now);
    // Then
    expect(clock).toBe("2026-10-06 01:30");
  });
});
