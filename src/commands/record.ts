import { Effect, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  NoRecordingError,
  NothingChangedError,
  ProviderError,
  RecordingRunningError,
  StopFlagsError,
} from "../errors.ts";
import { runHelper } from "../helper.ts";
import { ACTION_LOG_PATH, ActionLogLine, writeOut } from "../pixel.ts";
import { Progress } from "../progress.ts";
import { nothingChanged, parseProbe, planEdit } from "../proof/edit-plan.ts";
import { renderEdit } from "../proof/render-edit.ts";
import { encodeUnderLimit, PROOF_SIZE_DEFAULT } from "../proof/size-limit.ts";
import type { Os } from "../provider.ts";

export const RECORD_HELPER: Partial<Record<Os, string>> = {
  linux: "/opt/proofbox/record",
};

const CAPTION_FONT =
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";

const StoppedRecording = Schema.Struct({
  dir: Schema.String,
  start: Schema.Number,
  stop: Schema.Number,
  steps: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  width: Schema.Number.pipe(Schema.int(), Schema.positive()),
  height: Schema.Number.pipe(Schema.int(), Schema.positive()),
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
    if (options.discard === true) {
      const output = yield* CliOutput;
      yield* output.err(
        `proofbox: discarded the Recording; nothing was downloaded. The raw Recording stays at ${info.dir}/raw.mkv\n`,
      );
      return;
    }
    const out = options.out;
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
      if (nothingChanged(probe)) {
        return yield* new NothingChangedError({
          id: options.id,
          raw: `${info.dir}/raw.mkv`,
        });
      }
      const actionLog = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["fetch", ACTION_LOG_PATH],
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
        if (entry.kind === "mark") {
          marks.push(entry.t - info.start);
        } else if (entry.kind === "click") {
          clicks.push({ t: entry.t - info.start, x: entry.x, y: entry.y });
        }
      }
      const plan = planEdit({
        duration: probe.duration,
        freezes: probe.freezes,
        marks,
        clicks,
      });
      const script = renderEdit(plan, {
        width: info.width,
        height: info.height,
        dir: info.dir,
        font: CAPTION_FONT,
      });
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
    const video = yield* runHelper(
      options.id,
      RECORD_HELPER,
      ["fetch", `${info.dir}/proof.mp4`],
      { outcome: "no Proof video was made" },
    );
    if (video.code !== 0) {
      return yield* helperFailed(video);
    }
    yield* writeOut(out, video.stdout);
    const base = out.replace(/\.[^./\\]+$/, "");
    const lines = [out];
    for (let k = 1; k <= info.steps; k++) {
      const shot = yield* runHelper(
        options.id,
        RECORD_HELPER,
        ["fetch", `${info.dir}/shot-${k}.png`],
        { outcome: "no Proof video was made" },
      );
      if (shot.code !== 0) {
        return yield* helperFailed(shot);
      }
      const path = `${base}-${k}.png`;
      yield* writeOut(path, shot.stdout);
      lines.push(path);
    }
    const output = yield* CliOutput;
    yield* output.out(`${lines.join("\n")}\n`);
  }).pipe(Effect.scoped);
