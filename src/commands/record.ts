import { Effect, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  CaptureBlockedError,
  NoRecordingError,
  NothingChangedError,
  ProviderError,
  RecordingRunningError,
  StopFlagsError,
} from "../errors.ts";
import { fetchHelper, type HelperTable, runHelper } from "../helper.ts";
import { ACTION_LOG_PATHS, ActionLogLine } from "../pixel.ts";
import { Progress } from "../progress.ts";
import { nothingChanged, parseProbe, planEdit } from "../proof/edit-plan.ts";
import { renderEdit } from "../proof/render-edit.ts";
import { encodeUnderLimit, PROOF_SIZE_DEFAULT } from "../proof/size-limit.ts";
import type { Os } from "../provider.ts";

export const RECORD_HELPER: HelperTable = {
  feature: "recording",
  paths: { linux: "/opt/proofbox/record", macos: "/opt/proofbox/record" },
};

const CAPTION_FONTS: Readonly<Record<Os, string>> = {
  linux: "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  macos: "/System/Library/Fonts/Supplemental/Arial.ttf",
};

const PROOF_WIDTH = 1440;

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

export const startRecording = (id: string) =>
  Effect.gen(function* () {
    const started = yield* runHelper(id, RECORD_HELPER, ["start"], {
      outcome: "no Recording was started",
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
  }).pipe(Effect.scoped);

export const stopRecording = (options: {
  readonly id: string;
  readonly out?: string | undefined;
  readonly discard?: boolean | undefined;
  readonly maxSize?: number | undefined;
}) =>
  Effect.gen(function* () {
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
        { outcome: "no Proof video was made" },
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
      yield* output.err(
        `proofbox: discarded the Recording; nothing was downloaded. The raw Recording stays at ${info.dir}/raw.mkv\n`,
      );
      return;
    }
    if (out === undefined) {
      return yield* Effect.die(new Error("record stop lost --out"));
    }
    const buildProof = Effect.gen(function* () {
      const probed = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["probe", info.dir],
        { outcome: "no Proof video was made" },
      );
      if (probed.code !== 0) {
        return yield* helperFailed(probed);
      }
      const probe = parseProbe(probed.stdout.toString("utf8"));
      let check = probe;
      if (probe.freezes.length === 0 && probe.duration < 3) {
        const again = yield* runHelper(
          options.id,
          RECORD_HELPER,
          ["probe", info.dir, String(Math.max(probe.duration / 4, 0.1))],
          { outcome: "no Proof video was made" },
        );
        if (again.code !== 0) {
          return yield* helperFailed(again);
        }
        check = parseProbe(again.stdout.toString("utf8"));
      }
      if (nothingChanged(check)) {
        return yield* new NothingChangedError({
          id: options.id,
          raw: `${info.dir}/raw.mkv`,
        });
      }
      const actionLog = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["fetch", ACTION_LOG_PATHS[stopped.os]],
        { outcome: "no Proof video was made" },
      );
      if (actionLog.code !== 0) {
        return yield* helperFailed(actionLog);
      }
      const marks: number[] = [];
      const clicks: { t: number; x: number; y: number }[] = [];
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
        }
      }
      const plan = planEdit({
        duration: probe.duration,
        freezes: probe.freezes,
        marks,
        clicks,
      });
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
      const encode = (crf: number) =>
        Effect.gen(function* () {
          const built = yield* runHelper(
            options.id,
            RECORD_HELPER,
            ["build", info.dir, String(crf)],
            {
              outcome: "no Proof video was made",
              stdin: Stream.make(new TextEncoder().encode(script)),
            },
          );
          if (built.code !== 0) {
            return yield* helperFailed(built);
          }
          return Number(built.stdout.toString("utf8").trim());
        });
      yield* encodeUnderLimit(encode, {
        limit: options.maxSize ?? PROOF_SIZE_DEFAULT,
        raw: `${info.dir}/raw.mkv`,
      });
    });
    const progress = yield* Progress;
    yield* progress.step("building the Proof video", buildProof);
    const video = yield* fetchHelper(
      options.id,
      RECORD_HELPER,
      `${info.dir}/proof.mp4`,
      out,
      { outcome: "no Proof video was made" },
    );
    if (video.code !== 0) {
      return yield* helperFailed(video);
    }
    const lines = [out];
    for (let k = 1; k <= info.steps; k++) {
      const path = `${base}-${k}.png`;
      const shot = yield* fetchHelper(
        options.id,
        RECORD_HELPER,
        `${info.dir}/shot-${k}.png`,
        path,
        { outcome: "no Proof video was made" },
      );
      if (shot.code !== 0) {
        return yield* helperFailed(shot);
      }
      lines.push(path);
    }
    const output = yield* CliOutput;
    yield* output.out(`${lines.join("\n")}\n`);
  }).pipe(Effect.scoped);
