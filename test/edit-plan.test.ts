import { describe, expect, it } from "vitest";
import {
  labelText,
  nothingChanged,
  parseProbe,
  planEdit,
} from "../src/proof/edit-plan.ts";

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
      { x: 10, y: 20, from: 3.5, to: 4.3 },
    ]);
  });

  it("a click at the end of a cut keeps its ring into the hold", () => {
    // Given
    const input = {
      duration: 8,
      freezes: [] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [] as ReadonlyArray<number>,
      clicks: [{ t: 7.9, x: 720, y: 450 }],
    };
    // When
    const plan = planEdit(input);
    // Then
    const round2 = (n: number) => Math.round(n * 100) / 100;
    expect(
      plan.rings.map((r) => ({ ...r, from: round2(r.from), to: round2(r.to) })),
    ).toEqual([{ x: 720, y: 450, from: 7.9, to: 8.7 }]);
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

  it("an instant change between two still parts is kept", () => {
    // Given
    const input = {
      duration: 57.5,
      freezes: [
        [2.93, 30.77],
        [30.77, 57.5],
      ] as const,
      marks: [1.58, 29.82],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const rounded = plan.clips.map((clip) =>
      clip.kind === "cut"
        ? { ...clip, from: round2(clip.from), to: round2(clip.to) }
        : { ...clip, at: round2(clip.at) },
    );
    expect(rounded).toEqual([
      { kind: "cut", from: 0, to: 1.58, step: 0 },
      { kind: "cut", from: 1.58, to: 4.93, step: 1 },
      {
        kind: "still",
        at: 4.93,
        seconds: 2,
        label: "» 25 s later",
        step: 1,
      },
      { kind: "cut", from: 29.82, to: 32.77, step: 2 },
      {
        kind: "still",
        at: 32.77,
        seconds: 2,
        label: "» 25 s later",
        step: 2,
      },
    ]);
    expect(plan.seconds).toBeCloseTo(11.88);
  });

  it("a Recording with under 1 s of change is found as nothing changed", () => {
    // Given
    const still = { duration: 6.03, freezes: [[0, undefined] as const] };
    const moving = parseProbe(
      [
        "  Duration: 00:02:52.13, start: 0.000000, bitrate: 812 kb/s",
        "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 2",
        "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_end: 58.5",
        "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 59",
        "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_end: 115.5",
        "[freezedetect @ 0x5f] lavfi.freezedetect.freeze_start: 116",
      ].join("\n"),
    );
    // When
    const stillResult = nothingChanged(still);
    const movingResult = nothingChanged(moving);
    // Then
    expect(stillResult).toBe(true);
    expect(movingResult).toBe(false);
  });

  it("instant changes between still parts still count as changed", () => {
    // Given
    const toggled = {
      duration: 85,
      freezes: [
        [0, 5.03],
        [5.03, 57.73],
        [57.73, 85],
      ] as const,
    };
    // When
    const result = nothingChanged(toggled);
    // Then
    expect(result).toBe(false);
  });
});
