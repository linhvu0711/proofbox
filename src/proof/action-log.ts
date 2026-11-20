import { Effect, Schema } from "effect";
import { ActionLogLine } from "../pixel.ts";

type ActionKind = (typeof ActionLogLine.Type)["kind"];

const POINT_ACTIONS: ReadonlySet<ActionKind> = new Set([
  "click",
  "key",
  "scroll",
  "drag",
]);

// The time each action ran: typing from its `type` line (before the first
// letter) to its `typed` line (after the last), and a click, key, scroll, or
// drag at its line's time, which `planEdit` widens by 1 s each side like
// any change. Typing still running at record stop runs to the end of the
// Recording.
const actionSpans = (
  lines: ReadonlyArray<{ readonly kind: ActionKind; readonly t: number }>,
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
    } else if (POINT_ACTIONS.has(kind)) {
      spans.push([t, t]);
    }
  }
  if (open !== undefined) {
    spans.push([open, duration]);
  }
  return spans;
};

export const readActionLog = Effect.fn("actionLog.readActionLog")(function* (
  text: string,
  recording: {
    readonly start: number;
    readonly stop: number;
    readonly duration: number;
  },
) {
  const marks: number[] = [];
  const clicks: { t: number; x: number; y: number }[] = [];
  const actions: number[] = [];
  const waits: { t: number; reason: string }[] = [];
  const acting: { kind: ActionKind; t: number }[] = [];
  // Typing that began before the Recording and ended in it.
  let typedInside = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const entry = yield* Schema.decodeUnknown(Schema.parseJson(ActionLogLine))(
      line,
    );
    // Typing that began before the Recording counts from its start.
    if (
      (entry.kind === "type" || entry.kind === "typed") &&
      entry.t <= recording.stop
    ) {
      acting.push({
        kind: entry.kind,
        t: Math.max(0, Math.min(entry.t - recording.start, recording.duration)),
      });
    }
    if (entry.t < recording.start || entry.t > recording.stop) {
      continue;
    }
    const t = Math.min(entry.t - recording.start, recording.duration);
    if (entry.kind === "typed") {
      typedInside = true;
    }
    // Typing went in above, with the typing from before the Recording.
    if (entry.kind !== "type" && entry.kind !== "typed") {
      acting.push({ kind: entry.kind, t });
    }
    if (entry.kind === "mark") {
      marks.push(t);
    } else if (entry.kind === "click") {
      clicks.push({ t, x: entry.x, y: entry.y });
    } else if (entry.kind === "wait") {
      waits.push({ t, reason: entry.reason });
    }
    if (POINT_ACTIONS.has(entry.kind) || entry.kind === "type") {
      actions.push(t);
    }
  }
  return {
    marks,
    clicks,
    waits,
    actions,
    // An action can change too few pixels for freezedetect, such as one
    // letter or a small toolbar icon, so the time an action ran is never
    // a Still part, and an action in the Recording is change enough
    // (ADR 0006).
    spans: actionSpans(acting, recording.duration),
    // Only a line inside the Recording counts: a `type` line whose
    // helper failed before its `typed` line stays open in the Action log
    // for the Sandbox's life.
    acted: actions.length > 0 || typedInside,
  };
});
