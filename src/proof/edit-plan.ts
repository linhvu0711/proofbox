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
  readonly actions?: ReadonlyArray<number>;
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

export const nothingChanged = (probe: ProbeResult): boolean => {
  let still = 0;
  let position = 0;
  let points = 0;
  for (const [from, to] of probe.freezes) {
    if (from === position && position > 0) {
      points += 1;
    }
    still += (to ?? probe.duration) - Math.max(from, position);
    position = Math.max(position, to ?? probe.duration);
  }
  return probe.duration - still + points < 1;
};

// A Caller action logged up to 1 s before a Still part ends ended it: the
// Action log time runs about 0.47 s ahead of the video.
const CALLER_WINDOW = 1;

export const labelText = (seconds: number): string => {
  const n = Math.round(seconds);
  if (n < 60) {
    return `» ${n} s later`;
  }
  const minutes = Math.floor(n / 60);
  const rest = n % 60;
  return rest === 0
    ? `» ${minutes} min later`
    : `» ${minutes} min ${rest} s later`;
};

export const planEdit = (input: PlanInput): EditPlan => {
  const clips: Clip[] = [];
  const captions: Caption[] = [];
  const rings: Ring[] = [];
  // The label the Still part holding [from, to] keeps: none when the part
  // runs to the end of the Recording or a Caller action ended it (ADR 0018).
  const stillLabel = (from: number, to: number): string | undefined => {
    const freeze = input.freezes.find(
      ([a, b]) => a <= from && (b ?? input.duration) >= to,
    );
    if (freeze === undefined) {
      return labelText(to - from);
    }
    const end = freeze[1] ?? input.duration;
    if (end >= input.duration) {
      return undefined;
    }
    const ended = (input.actions ?? []).some(
      (t) => end - CALLER_WINDOW <= t && t <= end,
    );
    return ended ? undefined : labelText(to - from);
  };
  const count = input.marks.length === 0 ? 1 : input.marks.length + 1;
  const cutSpans: {
    from: number;
    to: number;
    out: number;
    after: number;
    step: number;
  }[] = [];
  let out = 0;
  for (let step = 0; step < count; step++) {
    const start = step === 0 ? 0 : (input.marks[step - 1] ?? 0);
    const end =
      step === count - 1
        ? input.duration
        : (input.marks[step] ?? input.duration);
    const outStart = out;
    const holds = step > 0 || input.marks.length === 0;

    const stills = input.freezes
      .map(([a, b]): readonly [number, number] => [
        Math.max(a, start),
        Math.min(b ?? input.duration, end),
      ])
      .filter(([a, b]) => b > a);
    const changing: [number, number][] = [];
    let position = start;
    for (const [a, b] of stills) {
      if (a > position) {
        changing.push([position, a]);
      } else if (a === position && position > start) {
        changing.push([a, a]);
      }
      position = Math.max(position, b);
    }
    if (position < end) {
      changing.push([position, end]);
    }

    const merged: [number, number][] = [];
    for (const [a, b] of changing) {
      const from = Math.max(a - 1, start);
      const to = Math.min(b + 2, end);
      const last = merged[merged.length - 1];
      if (last !== undefined && from - last[1] < 3) {
        last[1] = Math.max(last[1], to);
      } else {
        merged.push([from, to]);
      }
    }

    let endLabel: string | undefined;
    if (merged.length > 0) {
      const tail = end - (merged[merged.length - 1]?.[1] ?? end);
      if (tail >= 3) {
        endLabel = stillLabel(end - tail, end);
      } else {
        const last = merged[merged.length - 1];
        if (last !== undefined) {
          last[1] = end;
        }
      }
    }

    let cursor = start;
    for (const [a, b] of merged) {
      const gap = a - cursor;
      const gapLabel = gap >= 3 ? stillLabel(cursor, a) : undefined;
      if (gapLabel !== undefined) {
        clips.push({
          kind: "still",
          at: cursor,
          seconds: 2,
          label: gapLabel,
          step,
        });
        out += 2;
        const last = cutSpans[cutSpans.length - 1];
        if (last !== undefined && last.step === step) {
          last.after = out;
        }
      }
      clips.push({ kind: "cut", from: a, to: b, step });
      cutSpans.push({ from: a, to: b, out, after: out + (b - a), step });
      out += b - a;
      cursor = b;
    }
    if (holds) {
      if (merged.length === 0) {
        clips.push({
          kind: "still",
          at: start,
          seconds: 3,
          label: end - start >= 3 ? stillLabel(start, end) : undefined,
          step,
        });
        out += 3;
      } else {
        const seconds = Math.max(2, 3 - (out - outStart));
        clips.push({
          kind: "still",
          at: cursor,
          seconds,
          label: endLabel,
          step,
        });
        out += seconds;
        const last = cutSpans[cutSpans.length - 1];
        if (last !== undefined && last.step === step) {
          last.after = out;
        }
      }
      if (input.marks.length > 0) {
        captions.push({ step, from: outStart, to: out });
      }
    }
  }
  for (const click of input.clicks) {
    const span = cutSpans.find(
      ({ from, to }) => click.t >= from && click.t <= to,
    );
    if (span === undefined) {
      continue;
    }
    const from = span.out + click.t - span.from;
    rings.push({
      x: click.x,
      y: click.y,
      from,
      to: Math.min(from + 0.8, span.after),
    });
  }
  return { clips, captions, rings, seconds: out };
};
