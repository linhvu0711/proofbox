export type Clip =
  | {
      readonly kind: "cut";
      readonly from: number;
      readonly to: number;
      readonly step: number;
    }
  | {
      readonly kind: "still";
      readonly at: number;
      readonly seconds: number;
      readonly label?: string | undefined;
      readonly step: number;
    };

export interface Caption {
  readonly step: number;
  readonly from: number;
  readonly to: number;
}

export interface Ring {
  readonly x: number;
  readonly y: number;
  readonly from: number;
  readonly to: number;
}

export interface EditPlan {
  readonly clips: ReadonlyArray<Clip>;
  readonly captions: ReadonlyArray<Caption>;
  readonly rings: ReadonlyArray<Ring>;
  readonly seconds: number;
}

export interface ProbeResult {
  readonly duration: number;
  readonly freezes: ReadonlyArray<readonly [number, number | undefined]>;
}

export interface PlanInput {
  readonly duration: number;
  readonly freezes: ReadonlyArray<readonly [number, number | undefined]>;
  readonly marks: ReadonlyArray<number>;
  readonly clicks: ReadonlyArray<{
    readonly t: number;
    readonly x: number;
    readonly y: number;
  }>;
}

const parseTime = (text: string): number => {
  const [h = "0", m = "0", s = "0"] = text.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

export const parseProbe = (text: string): ProbeResult => {
  const duration = /Duration: (\d+:\d+:\d+\.\d+)/.exec(text);
  const freezes: [number, number | undefined][] = [];
  let pending: number | undefined;
  for (const line of text.split("\n")) {
    const start = /lavfi\.freezedetect\.freeze_start: ([\d.]+)/.exec(line);
    if (start?.[1] !== undefined) {
      pending = Number(start[1]);
      continue;
    }
    const end = /lavfi\.freezedetect\.freeze_end: ([\d.]+)/.exec(line);
    if (end?.[1] !== undefined && pending !== undefined) {
      freezes.push([pending, Number(end[1])]);
      pending = undefined;
    }
  }
  if (pending !== undefined) {
    freezes.push([pending, undefined]);
  }
  return {
    duration: duration?.[1] === undefined ? 0 : parseTime(duration[1]),
    freezes,
  };
};

export const planEdit = (input: PlanInput): EditPlan => {
  const clips: Clip[] = [];
  const captions: Caption[] = [];
  const count = input.marks.length === 0 ? 1 : input.marks.length + 1;
  let out = 0;
  for (let step = 0; step < count; step++) {
    const from = step === 0 ? 0 : (input.marks[step - 1] ?? 0);
    const to =
      step === count - 1 ? input.duration : (input.marks[step] ?? input.duration);
    const start = out;
    if (to > from) {
      clips.push({ kind: "cut", from, to, step });
      out += to - from;
    }
    if (step > 0 || input.marks.length === 0) {
      const still = Math.max(2, 3 - (out - start));
      clips.push({ kind: "still", at: to, seconds: still, step });
      out += still;
      if (input.marks.length > 0) {
        captions.push({ step, from: start, to: out });
      }
    }
  }
  return { clips, captions, rings: [], seconds: out };
};
