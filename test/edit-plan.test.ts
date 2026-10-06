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
      { kind: "still", at: 8, seconds: 4, step: 0 },
    ]);
    expect(plan.captions).toEqual([]);
    expect(plan.seconds).toBe(12);
  });

  it("each Step mark starts a step that ends on a 4 s hold", () => {
    // Given
    const input = { duration: 20, freezes: [], marks: [2, 10], clicks: [] };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 2, step: 0 },
      { kind: "cut", from: 2, to: 10, step: 1 },
      { kind: "still", at: 10, seconds: 4, step: 1 },
      { kind: "cut", from: 10, to: 20, step: 2 },
      { kind: "still", at: 20, seconds: 4, step: 2 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 2, to: 14 },
      { step: 2, from: 14, to: 28 },
    ]);
    expect(plan.seconds).toBe(28);
  });

  it("a step shorter than 4 s still ends on a 4 s hold", () => {
    // Given
    const input = { duration: 5, freezes: [], marks: [0, 0.5], clicks: [] };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 0.5, step: 1 },
      { kind: "still", at: 0.5, seconds: 4, step: 1 },
      { kind: "cut", from: 0.5, to: 5, step: 2 },
      { kind: "still", at: 5, seconds: 4, step: 2 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 0, to: 4.5 },
      { step: 2, from: 4.5, to: 13 },
    ]);
    expect(plan.seconds).toBe(13);
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
      { kind: "cut", from: 1, to: 3, step: 1 },
      { kind: "still", at: 3, seconds: 3, label: "» 56 s later", step: 1 },
      { kind: "cut", from: 58, to: 60, step: 2 },
      { kind: "still", at: 60, seconds: 3, label: "» 56 s later", step: 2 },
      { kind: "cut", from: 115, to: 117, step: 3 },
      { kind: "still", at: 117, seconds: 3, step: 3 },
    ]);
    expect(plan.captions).toEqual([
      { step: 1, from: 1, to: 6 },
      { step: 2, from: 6, to: 11 },
      { step: 3, from: 11, to: 16 },
    ]);
    expect(plan.seconds).toBe(16);
  });

  it("a Still part inside a step shows 1 s, a 2 s label, and 1 s", () => {
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
      { kind: "cut", from: 0, to: 6, step: 1 },
      { kind: "still", at: 6, seconds: 2, label: "» 25 s later", step: 1 },
      { kind: "cut", from: 29, to: 40, step: 1 },
      { kind: "still", at: 40, seconds: 4, step: 1 },
    ]);
    expect(plan.seconds).toBe(23);
  });

  it("a 4.5 s Still part is cut to 4 s", () => {
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
      { kind: "cut", from: 0, to: 4, step: 1 },
      { kind: "still", at: 4, seconds: 2, label: "» 5 s later", step: 1 },
      { kind: "cut", from: 6.5, to: 12, step: 1 },
      { kind: "still", at: 12, seconds: 4, step: 1 },
    ]);
    expect(plan.seconds).toBe(15.5);
  });

  it("a Still part a Caller action ends is cut to 4 s with no label", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      actions: [29.5],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 6, step: 1 },
      { kind: "still", at: 6, seconds: 2, step: 1 },
      { kind: "cut", from: 29, to: 40, step: 1 },
      { kind: "still", at: 40, seconds: 4, step: 1 },
    ]);
    expect(plan.seconds).toBe(23);
  });

  it("a Still part the app ends keeps its label", () => {
    // Given: a click at 10 s that changed nothing
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      actions: [10],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 25 s later",
      step: 1,
    });
  });

  it("a Caller action more than 1 s before the change leaves the label", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      actions: [28.9],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 25 s later",
      step: 1,
    });
  });

  it("a Still part at the end of the Recording is held 4 s with no label", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, undefined]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 6, step: 1 },
      { kind: "still", at: 6, seconds: 3, step: 1 },
    ]);
  });

  it("a Wait mark puts its reason after the label", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      actions: [29.5],
      waits: [{ t: 6, reason: "waiting for the scheduler" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 25 s later · waiting for the scheduler",
      step: 1,
    });
  });

  it("a Wait mark before a Still part goes on the next one in its step", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      actions: [29.5],
      waits: [{ t: 2, reason: "waiting for the scheduler" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 25 s later · waiting for the scheduler",
      step: 1,
    });
  });

  it("a Wait mark with no Still part in its step is not used", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 35],
      clicks: [],
      waits: [{ t: 36, reason: "nobody waits here" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.unusedWaits).toEqual([
      { reason: "nobody waits here", step: 2 },
    ]);
  });

  it("a Wait mark in the hold before the first Step mark is not used", () => {
    // Given: a change, then still until the first Step mark — that hold
    // shows in no clip, so a Wait mark that only matches it is not used.
    const input = {
      duration: 40,
      freezes: [
        [0, 10],
        [15, 40],
      ] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [35],
      clicks: [],
      waits: [{ t: 20, reason: "too early" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.unusedWaits).toEqual([{ reason: "too early", step: 0 }]);
    expect(
      plan.clips.every(
        (clip) => !(clip.kind === "still" && clip.label?.includes("too early")),
      ),
    ).toBe(true);
  });

  it("a Wait mark before the first Step mark goes on an early gap that is shown", () => {
    // Given: a still gap between changes before the first Step mark —
    // that gap keeps a clip, so a Wait mark in it is used.
    const input = {
      duration: 40,
      freezes: [
        [0, 10],
        [15, 40],
      ] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [35],
      clicks: [],
      waits: [{ t: 5, reason: "too early" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.unusedWaits).toEqual([]);
    expect(plan.clips[0]).toEqual({
      kind: "still",
      at: 0,
      seconds: 3,
      label: "» 10 s later · too early",
      step: 0,
    });
  });

  it("two Wait marks on one Still part show the first reason", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      waits: [
        { t: 6, reason: "first reason" },
        { t: 8, reason: "second reason" },
      ],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 25 s later · first reason",
      step: 1,
    });
  });

  it("the second Wait mark on one Still part is not used", () => {
    // Given: the same input as the case above
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      waits: [
        { t: 6, reason: "first reason" },
        { t: 8, reason: "second reason" },
      ],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.unusedWaits).toEqual([{ reason: "second reason", step: 1 }]);
  });

  it("a Still part across a Step mark that a Caller action ends has no label on either side", () => {
    // Given
    const input = {
      duration: 40,
      freezes: [[5, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 15],
      clicks: [],
      actions: [29.5],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 6, step: 1 },
      { kind: "still", at: 6, seconds: 3, step: 1 },
      { kind: "still", at: 15, seconds: 3, step: 2 },
      { kind: "cut", from: 29, to: 40, step: 2 },
      { kind: "still", at: 40, seconds: 4, step: 2 },
    ]);
    expect(plan.seconds).toBe(27);
  });

  it("a Still part under 4 s between two actions plays as recorded, with no label", () => {
    // Given
    const input = {
      duration: 20,
      freezes: [
        [5, 7],
        [10, 13.9],
      ] as ReadonlyArray<readonly [number, number | undefined]>,
      marks: [0],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 20, step: 1 },
      { kind: "still", at: 20, seconds: 4, step: 1 },
    ]);
  });

  it("a 60 s Still part becomes 4 s with a » 1 min later label", () => {
    // Given
    const input = {
      duration: 80,
      freezes: [[5, 65]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 6, step: 1 },
      { kind: "still", at: 6, seconds: 2, label: "» 1 min later", step: 1 },
      { kind: "cut", from: 64, to: 80, step: 1 },
      { kind: "still", at: 80, seconds: 4, step: 1 },
    ]);
  });

  it("a 60 s Still part a Wait mark names shows its reason", () => {
    // Given
    const input = {
      duration: 80,
      freezes: [[5, 65]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [],
      waits: [{ t: 10, reason: "waiting for the scheduler" }],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips[1]).toEqual({
      kind: "still",
      at: 6,
      seconds: 2,
      label: "» 1 min later · waiting for the scheduler",
      step: 1,
    });
  });

  it("a last screen still for 3.5 s before the Step mark gets a 1 s hold", () => {
    // Given: the step's action ends 3.5 s before the next Step mark
    const input = {
      duration: 20,
      freezes: [[6.5, 10]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 10],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 10, step: 1 },
      { kind: "still", at: 10, seconds: 1, step: 1 },
      { kind: "cut", from: 10, to: 20, step: 2 },
      { kind: "still", at: 20, seconds: 4, step: 2 },
    ]);
  });

  it("a step with no change is held 4 s with its label", () => {
    // Given: step 2 runs from 10 s to 20 s inside one Still part
    const input = {
      duration: 40,
      freezes: [[8, 30]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 10, 20],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips.filter((clip) => clip.step === 2)).toEqual([
      { kind: "still", at: 10, seconds: 4, label: "» 10 s later", step: 2 },
    ]);
  });

  it("a Still part under 4 s at a step's start plays as recorded", () => {
    // Given: a Still part from 8 s to 12 s, across the Step mark at 10 s
    const input = {
      duration: 20,
      freezes: [[8, 12]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 10],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips).toEqual([
      { kind: "cut", from: 0, to: 10, step: 1 },
      { kind: "still", at: 10, seconds: 2, step: 1 },
      { kind: "cut", from: 10, to: 20, step: 2 },
      { kind: "still", at: 20, seconds: 4, step: 2 },
    ]);
  });

  it("a Still part of 4 s or more at a step's start shows 3 s still and 1 s as recorded", () => {
    // Given: a Still part from 8 s to 16 s, across the Step mark at 10 s
    const input = {
      duration: 30,
      freezes: [[8, 16]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0, 10],
      clicks: [],
    };
    // When
    const plan = planEdit(input);
    // Then
    expect(plan.clips.filter((clip) => clip.step === 2)).toEqual([
      { kind: "still", at: 10, seconds: 3, label: "» 6 s later", step: 2 },
      { kind: "cut", from: 15, to: 30, step: 2 },
      { kind: "still", at: 30, seconds: 4, step: 2 },
    ]);
  });

  it("a click after a cut Still part rings at its place in the video", () => {
    // Given
    const input = {
      duration: 80,
      freezes: [[5, 65]] as ReadonlyArray<
        readonly [number, number | undefined]
      >,
      marks: [0],
      clicks: [
        { t: 64.6, x: 100, y: 200 },
        { t: 79.9, x: 5, y: 6 },
      ],
    };
    // When
    const plan = planEdit(input);
    // Then
    const round2 = (n: number) => Math.round(n * 100) / 100;
    expect(
      plan.rings.map((r) => ({ ...r, from: round2(r.from), to: round2(r.to) })),
    ).toEqual([
      { x: 100, y: 200, from: 8.6, to: 9.4 },
      { x: 5, y: 6, from: 23.9, to: 24.7 },
    ]);
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

  it("each click shown in the video gets a ring for 0.8 s at its place", () => {
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
    expect(plan.rings).toEqual([{ x: 700, y: 400, from: 1.5, to: 2.3 }]);
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
      { kind: "cut", from: 1.58, to: 3.93, step: 1 },
      {
        kind: "still",
        at: 3.93,
        seconds: 3,
        label: "» 27 s later",
        step: 1,
      },
      { kind: "cut", from: 29.82, to: 31.77, step: 2 },
      {
        kind: "still",
        at: 31.77,
        seconds: 3,
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
