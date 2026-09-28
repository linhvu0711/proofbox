import { describe, expect, it } from "vitest";
import { labelText, parseProbe, planEdit } from "../src/proof/edit-plan.ts";

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

  it("a 3-minute Recording with long pauses comes out at 16 s", () => {
    // Given
    const input = {
      duration: 172,
      freezes: [
        [2, 58.5],
        [59, 115.5],
        [116, undefined],
      ] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [1, 58, 115],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 1, step: 0 },
      { kind: "cut", from: 1, to: 4, step: 1 },
      { kind: "still", at: 4, seconds: 2, label: "» 54 s later", step: 1 },
      { kind: "cut", from: 58, to: 61, step: 2 },
      { kind: "still", at: 61, seconds: 2, label: "» 54 s later", step: 2 },
      { kind: "cut", from: 115, to: 118, step: 3 },
      { kind: "still", at: 118, seconds: 2, label: "» 54 s later", step: 3 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 1, to: 6 },
      { step: 2, from: 6, to: 11 },
      { step: 3, from: 11, to: 16 },
    ]);
    expect(plan.seconds).toBe(16);
  });

  it("a still part inside a step becomes a 2 s label", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 7, step: 1 },
      { kind: "still", at: 7, seconds: 2, label: "» 22 s later", step: 1 },
      { kind: "cut", from: 29, to: 40, step: 1 },
      { kind: "still", at: 40, seconds: 2, step: 1 },
    ]);
    expect(plan.seconds).toBe(22);
  });

  it("a still part under 3 s after its margins is kept", () => {
    // Given
    const input = {
      duration: 12,
      freezes: [[3, 7.5]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 12, step: 1 },
      { kind: "still", at: 12, seconds: 2, step: 1 },
    ]);
    expect(plan.seconds).toBe(14);
  });

  it("the label reads seconds, then minutes", () => {
    // Given
    const numbers = [54, 110, 120];
    // When
    const labels = numbers.map(labelText);
    // Then
    expect(labels).toEqual([
      "» 54 s later",
      "» 1 min 50 s later",
      "» 2 min later",
    ]);
  });

  it("each click gets a ring for 0.8 s at its place in the video", () => {
    // Given
    const input = {
      duration: 172,
      freezes: [
        [2, 58.5],
        [59, 115.5],
        [116, undefined],
      ] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [1, 58, 115],
      clicks: [
        { t: 1.5, x: 700, y: 400 },
        { t: 3.5, x: 10, y: 20 },
        { t: 30, x: 5, y: 5 },
      ],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.rings).toEqual([
      { x: 700, y: 400, from: 1.5, to: 2.3 },
      { x: 10, y: 20, from: 3.5, to: 4 },
    ]);
  });

  it("parseProbe reads the duration and each still part", () => {
    // Given
    const text = [
      "  Duration: 00:02:52.13, start: 0.000000, bitrate: 812 kb/s",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 2",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_duration: 56.5",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_end: 58.5",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 59",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_end: 115.5",
      "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 116",
    ].join("\n");
    // When
    const probe = parseProbe(text);
    // Then
    expect(probe).toEqual({
      duration: 172.13,
      freezes: [
        [2, 58.5],
        [59, 115.5],
        [116, undefined],
      ],
    });
  });
});
