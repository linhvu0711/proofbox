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
  readonly unusedWaits: ReadonlyArray<{
    readonly reason: string;
    readonly step: number;
  }>;
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
  readonly waits?: ReadonlyArray<{
    readonly t: number;
    readonly reason: string;
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

// Takes each span out of the Still parts it overlaps, so the edit keeps
// it at real speed. Only the edit uses it: the nothing-changed check still
// needs a change freezedetect saw.
export const withoutSpans = (
  freezes: ReadonlyArray<readonly [number, number | undefined]>,
  spans: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number | undefined]> =>
  spans.reduce<ReadonlyArray<readonly [number, number | undefined]>>(
    (parts, [from, to]) =>
      parts.flatMap(([a, b]) => {
        if (to <= a || (b !== undefined && from >= b)) {
          return [[a, b]];
        }
        const kept: (readonly [number, number | undefined])[] = [];
        if (from > a) {
          kept.push([a, from]);
        }
        if (b === undefined || to < b) {
          kept.push([to, b]);
        }
        return kept;
      }),
    freezes,
  );

// The time each type action ran, from its `type` line (before the first
// letter) to its `typed` line (after the last). Typing still running at
// record stop runs to the end of the Recording.
export const typingSpans = (
  lines: ReadonlyArray<{ readonly kind: string; readonly t: number }>,
  duration: number,
): ReadonlyArray<readonly [number, number]> => {
  const spans: (readonly [number, number])[] = [];
  let open: number | undefined;
  for (const { kind, t } of lines) {
    if (kind === "type") {
      open = t;
    } else if (kind === "typed") {
      spans.push([open ?? 0, t]);
      open = undefined;
    }
  }
  if (open !== undefined) {
    spans.push([open, duration]);
  }
  return spans;
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
  const unusedWaits: { reason: string; step: number }[] = [];
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

    // Each change keeps 1 s before and after it. A Still part under 4 s
    // plays as recorded, so the spans around it merge, and the first span
    // starts at the step's start when the Still part before it is that short.
    const merged: [number, number][] = [];
    for (const [a, b] of changing) {
      const pad = Math.max(a - 1, start);
      const from = merged.length === 0 && pad - start < 3 ? start : pad;
      const to = Math.min(b + 1, end);
      const last = merged[merged.length - 1];
      if (last !== undefined && from - last[1] < 2) {
        last[1] = Math.max(last[1], to);
      } else {
        merged.push([from, to]);
      }
    }

    // This step's Still parts of 4 s or more, in order: each gap between
    // spans, which gets a still clip (its screen changes again at a + 1),
    // then the tail or the empty step, which end at the step's end.
    const stillParts: {
      from: number;
      to: number;
      endsAt: number;
      reason?: string;
    }[] = [];
    {
      let position = start;
      for (const [a, b] of merged) {
        if (a > position) {
          stillParts.push({ from: position, to: a, endsAt: a + 1 });
        }
        position = b;
      }
      if (merged.length === 0) {
        if (holds) {
          stillParts.push({ from: start, to: end, endsAt: end });
        }
      } else if (holds && end - position >= 3) {
        stillParts.push({ from: position, to: end, endsAt: end });
      }
    }
    // A Wait mark goes to the first Still part of its step that ends
    // after it; one whose Still part is taken or missing is not used.
    for (const wait of input.waits ?? []) {
      const inStep =
        wait.t >= start &&
        (wait.t < end || (step === count - 1 && wait.t === end));
      if (!inStep) {
        continue;
      }
      const part = stillParts.find(({ endsAt }) => endsAt > wait.t);
      if (part === undefined || part.reason !== undefined) {
        unusedWaits.push({ reason: wait.reason, step });
      } else {
        part.reason = wait.reason;
      }
    }

    let endLabel: string | undefined;
    if (merged.length > 0) {
      const tail = end - (merged[merged.length - 1]?.[1] ?? end);
      if (tail >= 3) {
        const reason = stillParts.at(-1)?.reason;
        endLabel =
          reason !== undefined
            ? `${labelText(tail + 1)} · ${reason}`
            : stillLabel(end - tail - 1, end);
      } else {
        const last = merged[merged.length - 1];
        if (last !== undefined) {
          last[1] = end;
        }
      }
    }

    // A Still part of 4 s or more shows 4 s: 1 s after the change before it
    // (none at the step's start), a still clip, and 1 s before the next
    // change. Its label tells how long the whole Still part was.
    let stillIndex = 0;
    let cursor = start;
    for (const [a, b] of merged) {
      if (a > cursor) {
        const reason = stillParts[stillIndex]?.reason;
        stillIndex += 1;
        const from = cursor === start ? start : cursor - 1;
        const seconds = cursor === start ? 3 : 2;
        clips.push({
          kind: "still",
          at: cursor,
          seconds,
          label:
            reason !== undefined
              ? `${labelText(a + 1 - from)} · ${reason}`
              : stillLabel(from, a + 1),
          step,
        });
        out += seconds;
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
        const reason = stillParts[stillIndex]?.reason;
        clips.push({
          kind: "still",
          at: start,
          seconds: 4,
          label:
            end - start >= 4
              ? reason !== undefined
                ? `${labelText(end - start)} · ${reason}`
                : stillLabel(start, end)
              : undefined,
          step,
        });
        out += 4;
      } else {
        // The step's last screen shows at least 4 s: a cut tail keeps 1 s
        // and a 3 s hold; a shorter still tail gets the rest of 4 s, at
        // least 1 s, since a hold of no frames makes ffmpeg loop forever.
        const still = end - (changing.at(-1)?.[1] ?? end);
        const seconds = still >= 4 ? 3 : Math.max(1, 4 - still);
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
  return { clips, captions, rings, seconds: out, unusedWaits };
};
