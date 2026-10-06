import { Duration, Effect, Option, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  CaptureBlockedError,
  NoRecordingError,
  NothingChangedError,
  ProviderError,
  RecordingRunningError,
  StopFlagsError,
} from "../errors.ts";
import {
  fetchHelper,
  type HelperLimit,
  type HelperTable,
  runHelper,
} from "../helper.ts";
import { ACTION_LOG_PATHS, ActionLogLine } from "../pixel.ts";
import { Progress } from "../progress.ts";
import {
  nothingChanged,
  type ProbeResult,
  parseProbe,
  planEdit,
  withoutSpans,
} from "../proof/edit-plan.ts";
import { renderEdit } from "../proof/render-edit.ts";
import { encodeUnderLimit, PROOF_SIZE_DEFAULT } from "../proof/size-limit.ts";
import type { Os } from "../provider.ts";
import { Style } from "../style.ts";
import { formatMb } from "../upload/max-size.ts";

export const RECORD_HELPER: HelperTable = {
  feature: "recording",
  paths: { linux: "/opt/proofbox/record", macos: "/opt/proofbox/record" },
};

const CAPTION_FONTS: Readonly<Record<Os, string>> = {
  linux: "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  macos: "/System/Library/Fonts/Supplemental/Arial.ttf",
};

const PROOF_WIDTH = 1440;

// Every call `record stop` makes, from the stop to the build, is one
// `record stop` to the Caller: it changes something, so it is never
// tried again (ADR 0019).
const STOP_LIMIT: HelperLimit = {
  _tag: "Act",
  name: "record stop",
  extra: Duration.zero,
};

const StoppedRecording = Schema.Struct({
  dir: Schema.String,
  start: Schema.Number,
  stop: Schema.Number,
  steps: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  width: Schema.Number.pipe(Schema.int(), Schema.positive()),
  height: Schema.Number.pipe(Schema.int(), Schema.positive()),
  blocked: Schema.optional(
    Schema.Literal(
      "the capture stopped",
      "the capture stalled",
      "an alert is on screen",
    ),
  ),
});

export const startRecording = Effect.fn("record.startRecording")(function* (
  id: string,
) {
  const started = yield* runHelper(id, RECORD_HELPER, ["start"], {
    outcome: "no Recording was started",
    limit: { _tag: "Act", name: "record start", extra: Duration.zero },
  });
  if (started.code === 4) {
    return yield* new RecordingRunningError({ id });
  }
  if (started.code !== 0) {
    return yield* new ProviderError({
      provider: started.provider,
      reason: `Recording helper failed: ${started.stderr}`,
    });
  }
  const progress = yield* Progress;
  yield* progress.done("Recording started");
  yield* progress.hint(
    `stop it with proofbox record stop ${id} --out proof.mp4`,
  );
}, Effect.scoped);

// A Step mark's label, as the Caller gave it to `mark`: the helper keeps it
// in `caption-<step>.txt` in the Recording folder, with no newline.
export const readStepLabel = Effect.fn("record.readStepLabel")(function* (
  id: string,
  dir: string,
  step: number,
) {
  const caption = yield* runHelper(
    id,
    RECORD_HELPER,
    ["fetch", `${dir}/caption-${step}.txt`],
    {
      outcome: "no Proof video was made",
      limit: { _tag: "Download", name: "Step label" },
    },
  );
  if (caption.code !== 0) {
    return yield* new ProviderError({
      provider: caption.provider,
      reason: `Recording helper failed: ${caption.stderr}`,
    });
  }
  return caption.stdout.toString("utf8");
});

export const stopRecording = Effect.fn("record.stopRecording")(
  function* (options: {
    readonly id: string;
    readonly out?: string | undefined;
    readonly discard?: boolean | undefined;
    readonly maxSize?: number | undefined;
    readonly json?: boolean | undefined;
  }) {
    if (options.out === undefined && options.discard !== true) {
      return yield* new StopFlagsError({ both: false });
    }
    if (options.out !== undefined && options.discard === true) {
      return yield* new StopFlagsError({ both: true });
    }
    const helperFailed = (result: {
      readonly provider: string;
      readonly code: number | undefined;
      readonly stderr: string;
    }) =>
      new ProviderError({
        provider: result.provider,
        reason: `Recording helper failed: ${result.stderr}`,
      });
    const stopped = yield* runHelper(options.id, RECORD_HELPER, ["stop"], {
      outcome: "no Recording was stopped",
      limit: STOP_LIMIT,
    });
    if (stopped.code === 5) {
      return yield* new NoRecordingError({ id: options.id });
    }
    if (stopped.code !== 0) {
      return yield* helperFailed(stopped);
    }
    const info = yield* Schema.decodeUnknown(
      Schema.parseJson(StoppedRecording),
    )(stopped.stdout.toString("utf8").trim());
    const out = options.out;
    const base = out?.replace(/\.[^./\\]+$/, "") ?? "proof";
    if (info.blocked !== undefined) {
      let screenshot: string | undefined;
      const saved = yield* fetchHelper(
        options.id,
        RECORD_HELPER,
        `${info.dir}/blocked.png`,
        `${base}-blocked.png`,
        { outcome: "no Proof video was made", name: "blocked-screen image" },
      ).pipe(
        // The blocked capture is what the caller must hear about; a
        // screen that cannot be fetched only loses its screenshot.
        Effect.catchAll(() => Effect.succeed({ code: 1 })),
      );
      if (saved.code === 0) {
        screenshot = `${base}-blocked.png`;
      }
      return yield* new CaptureBlockedError({
        id: options.id,
        what: info.blocked,
        screenshot,
      });
    }
    if (options.discard === true) {
      const output = yield* CliOutput;
      const progress = yield* Progress;
      yield* progress.note(
        `discarded the Recording; nothing was downloaded. The raw Recording stays at ${info.dir}/raw.mkv`,
      );
      if (options.json === true) {
        yield* output.out(
          `${JSON.stringify({ discarded: true, raw: `${info.dir}/raw.mkv` })}\n`,
        );
      }
      return;
    }
    if (out === undefined) {
      return yield* Effect.die(new Error("record stop lost --out"));
    }
    // Checking and building the Proof video run as long as the Recording,
    // so they get its length on top of the wait.
    const buildLimit: HelperLimit = {
      ...STOP_LIMIT,
      extra: Duration.seconds(info.stop - info.start),
    };
    const buildProof = Effect.gen(function* () {
      const probed = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["probe", info.dir],
        { outcome: "no Proof video was made", limit: buildLimit },
      );
      if (probed.code !== 0) {
        return yield* helperFailed(probed);
      }
      const probe = parseProbe(probed.stdout.toString("utf8"));
      const actionLog = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["fetch", ACTION_LOG_PATHS[stopped.os]],
        {
          outcome: "no Proof video was made",
          limit: { _tag: "Download", name: "Action log" },
        },
      );
      if (actionLog.code !== 0) {
        return yield* helperFailed(actionLog);
      }
      const marks: number[] = [];
      const clicks: { t: number; x: number; y: number }[] = [];
      const actions: number[] = [];
      const typing: [number, number][] = [];
      const waits: { t: number; reason: string }[] = [];
      for (const line of actionLog.stdout.toString("utf8").split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        const entry = yield* Schema.decodeUnknown(
          Schema.parseJson(ActionLogLine),
        )(line);
        if (entry.t < info.start || entry.t > info.stop) {
          continue;
        }
        const t = Math.min(entry.t - info.start, probe.duration);
        if (entry.kind === "mark") {
          marks.push(t);
        } else if (entry.kind === "click") {
          clicks.push({ t, x: entry.x, y: entry.y });
        } else if (entry.kind === "wait") {
          waits.push({ t, reason: entry.reason });
        } else if (entry.kind === "type" && entry.until !== undefined) {
          typing.push([t, Math.min(entry.until - info.start, probe.duration)]);
        }
        if (
          entry.kind === "click" ||
          entry.kind === "type" ||
          entry.kind === "key" ||
          entry.kind === "scroll" ||
          entry.kind === "drag"
        ) {
          actions.push(t);
        }
      }
      const freezes = withoutSpans(probe.freezes, typing);
      let check: ProbeResult = { duration: probe.duration, freezes };
      if (probe.freezes.length === 0 && probe.duration < 3) {
        const again = yield* runHelper(
          options.id,
          RECORD_HELPER,
          ["probe", info.dir, String(Math.max(probe.duration / 4, 0.1))],
          { outcome: "no Proof video was made", limit: buildLimit },
        );
        if (again.code !== 0) {
          return yield* helperFailed(again);
        }
        const short = parseProbe(again.stdout.toString("utf8"));
        check = {
          duration: short.duration,
          freezes: withoutSpans(short.freezes, typing),
        };
      }
      if (nothingChanged(check)) {
        return yield* new NothingChangedError({
          id: options.id,
          raw: `${info.dir}/raw.mkv`,
        });
      }
      const plan = planEdit({
        duration: probe.duration,
        freezes,
        marks,
        clicks,
        actions,
        waits,
      });
      const progress = yield* Progress;
      for (const wait of plan.unusedWaits) {
        yield* progress.warn(
          wait.step === 0
            ? `Wait mark "${wait.reason}" found no free Still part before the first Step mark`
            : `Wait mark "${wait.reason}" found no free Still part in step ${wait.step}`,
        );
      }
      const script = renderEdit(
        plan,
        info.width === PROOF_WIDTH
          ? {
              width: info.width,
              height: info.height,
              dir: info.dir,
              font: CAPTION_FONTS[stopped.os],
            }
          : {
              width: PROOF_WIDTH,
              height:
                Math.round((info.height * PROOF_WIDTH) / info.width / 2) * 2,
              dir: info.dir,
              font: CAPTION_FONTS[stopped.os],
              screen: { width: info.width, height: info.height },
            },
      );
      const encode = Effect.fn("record.encode")(function* (crf: number) {
        const built = yield* runHelper(
          options.id,
          RECORD_HELPER,
          ["build", info.dir, String(crf)],
          {
            outcome: "no Proof video was made",
            stdin: Stream.make(new TextEncoder().encode(script)),
            limit: buildLimit,
          },
        );
        if (built.code !== 0) {
          return yield* helperFailed(built);
        }
        return Number(built.stdout.toString("utf8").trim());
      });
      return yield* encodeUnderLimit(encode, {
        limit,
        raw: `${info.dir}/raw.mkv`,
      });
    });
    const limit = options.maxSize ?? PROOF_SIZE_DEFAULT;
    const progress = yield* Progress;
    const style = yield* Style;
    const bytes = yield* progress.step("building the Proof video", buildProof);
    const video = yield* fetchHelper(
      options.id,
      RECORD_HELPER,
      `${info.dir}/proof.mp4`,
      out,
      { outcome: "no Proof video was made", name: "Proof video" },
    );
    if (video.code !== 0) {
      return yield* helperFailed(video);
    }
    const screenshots: { step: number; label?: string; path: string }[] = [];
    for (let k = 1; k <= info.steps; k++) {
      const path = `${base}-${k}.png`;
      const shot = yield* fetchHelper(
        options.id,
        RECORD_HELPER,
        `${info.dir}/shot-${k}.png`,
        path,
        { outcome: "no Proof video was made", name: "Proof screenshot" },
      );
      if (shot.code !== 0) {
        return yield* helperFailed(shot);
      }
      // Only the JSON holds the labels, so a plain path for a program reads
      // none.
      screenshots.push(
        options.json === true
          ? {
              step: k,
              label: yield* readStepLabel(options.id, info.dir, k),
              path,
            }
          : { step: k, path },
      );
    }
    const output = yield* CliOutput;
    if (options.json === true) {
      yield* output.out(`${JSON.stringify({ video: out, screenshots })}\n`);
      return;
    }
    const lines = [out, ...screenshots.map((shot) => shot.path)];
    yield* output.out(`${lines.join("\n")}\n`);
    // The hints are for a person only, and each label costs a fetch, so a
    // program pays for none of it.
    if (!style.look) {
      return;
    }
    yield* progress.hint(
      `Proof video ${out}, ${formatMb(bytes)} MB of the ${formatMb(limit)} MB Size limit`,
    );
    // The files are saved by now; a label that cannot be read only leaves
    // its line without one.
    for (const shot of screenshots) {
      const label = yield* readStepLabel(options.id, info.dir, shot.step).pipe(
        Effect.option,
      );
      yield* progress.hint(
        Option.match(label, {
          onNone: () => `Proof screenshot ${shot.path}, Step ${shot.step}`,
          onSome: (text) =>
            `Proof screenshot ${shot.path}, Step ${shot.step} "${text}"`,
        }),
      );
    }
  },
  Effect.scoped,
);
