import { Effect, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { ProviderError } from "../errors.ts";
import { runHelper } from "../helper.ts";
import { ACTION_LOG_PATH, ActionLogLine, writeOut } from "../pixel.ts";
import { type Os } from "../provider.ts";
import { parseProbe, planEdit } from "../proof/edit-plan.ts";
import { renderEdit } from "../proof/render-edit.ts";

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
    if (started.code !== 0) {
      return yield* new ProviderError({
        provider: started.provider,
        reason: `Recording helper failed: ${started.stderr}`,
      });
    }
  }).pipe(Effect.scoped);

export const stopRecording = (options: {
  readonly id: string;
  readonly out: string;
}) =>
  Effect.gen(function* () {
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
    if (stopped.code !== 0) {
      return yield* helperFailed(stopped);
    }
    const info = yield* Schema.decodeUnknown(
      Schema.parseJson(StoppedRecording),
    )(stopped.stdout.toString("utf8").trim());
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
    const built = yield* runHelper(
      options.id,
      RECORD_HELPER,
      ["build", info.dir, "23"],
      {
        outcome: "no Proof video was made",
        stdin: Stream.make(new TextEncoder().encode(script)),
      },
    );
    if (built.code !== 0) {
      return yield* helperFailed(built);
    }
    const video = yield* runHelper(
      options.id,
      RECORD_HELPER,
      ["fetch", `${info.dir}/proof.mp4`],
      { outcome: "no Proof video was made" },
    );
    if (video.code !== 0) {
      return yield* helperFailed(video);
    }
    yield* writeOut(options.out, video.stdout);
    const base = options.out.replace(/\.[^./\\]+$/, "");
    const lines = [options.out];
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
