import { Data } from "effect";
import type { Os } from "./provider.ts";
import { formatMb } from "./upload/max-size.ts";

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string;
  readonly reason: string;
}> {
  get message() {
    return `Provider ${this.provider} failed: ${this.reason}`;
  }
}

export class ProviderUnavailableError extends Data.TaggedError(
  "ProviderUnavailableError",
)<{
  readonly provider: string;
  readonly reason: string;
}> {
  get message() {
    return this.reason;
  }
}

export class ToolBundleHashError extends Data.TaggedError(
  "ToolBundleHashError",
)<{
  readonly file: string;
  readonly sandboxId: string;
  // The image that carried the file; a Mac fetches its tools itself.
  readonly tag?: string | undefined;
}> {
  get message() {
    const next =
      this.tag === undefined
        ? "Run create again"
        : `Run docker image rm ${this.tag} and try again`;
    return `Tool bundle file ${this.file} has the wrong hash; deleted ${this.sandboxId}. ${next}`;
  }
  get reason() {
    return this.message;
  }
}

export class SandboxGoneError extends Data.TaggedError("SandboxGoneError")<{
  readonly id: string;
}> {
  get message() {
    return `Sandbox ${this.id} is gone`;
  }
}

export class BadSpanError extends Data.TaggedError("BadSpanError")<{
  readonly flag: string;
  readonly value: string;
  readonly units: ReadonlyArray<string>;
  readonly example: string;
}> {
  get message() {
    const list =
      this.units.length <= 2
        ? this.units.join(" or ")
        : `${this.units.slice(0, -1).join(", ")}, or ${this.units[this.units.length - 1]}`;
    return `Bad --${this.flag} "${this.value}": use a whole number with ${list}, for example ${this.example}`;
  }
}

export class OutFileError extends Data.TaggedError("OutFileError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message() {
    return `Could not write ${this.path}: ${this.reason}. Check the folder exists and try again.`;
  }
}

export class OutsideScreenError extends Data.TaggedError("OutsideScreenError")<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}> {
  get message() {
    return `Point ${this.x},${this.y} is outside the screen (${this.width}x${this.height}); use x 0 to ${this.width - 1} and y 0 to ${this.height - 1}`;
  }
}

export class NotGitFolderError extends Data.TaggedError("NotGitFolderError")<{
  readonly folder: string;
}> {
  get message() {
    return `Upload needs a git folder: ${this.folder} is not a git folder. Run git init there, or pass a git folder.`;
  }
}

export class UploadFailedError extends Data.TaggedError("UploadFailedError")<{
  readonly id: string;
  readonly command: string;
  readonly code: number;
}> {
  get message() {
    return `Upload to ${this.id} failed: ${this.command} exited ${this.code}. Run upload again; it sends every file.`;
  }
}

export class SecretsSendFailedError extends Data.TaggedError(
  "SecretsSendFailedError",
)<{
  readonly id: string;
  readonly code: number;
}> {
  get message() {
    return `Sending Secrets to ${this.id} failed: sh exited ${this.code}. This Sandbox was deleted; create again.`;
  }
}

export class BadMaxSizeError extends Data.TaggedError("BadMaxSizeError")<{
  readonly value: string;
}> {
  get message() {
    return `Bad --max-size "${this.value}": use a whole number with MB or GB, for example 800MB`;
  }
}

export class BadMarkError extends Data.TaggedError("BadMarkError")<{
  readonly label: string;
}> {
  get message() {
    return `Bad Step mark "${this.label}": use 1 to 60 characters on one line, for example "step 3: save the post"`;
  }
}

export class WorkFolderTooBigError extends Data.TaggedError(
  "WorkFolderTooBigError",
)<{
  readonly bytes: number;
  readonly limit: number;
}> {
  get message() {
    return `Work folder is ${formatMb(this.bytes)} MB, over the ${formatMb(this.limit)} MB limit, so nothing was sent. Git-ignore the big files, or raise the limit with --max-size.`;
  }
}

export class WorkFileGrewError extends Data.TaggedError("WorkFileGrewError")<{
  readonly limit: number;
}> {
  get message() {
    return `A Work file grew while uploading, so the upload stopped past the ${formatMb(this.limit)} MB limit. Run it again, or raise the limit with --max-size.`;
  }
}

export class ProofTooBigError extends Data.TaggedError("ProofTooBigError")<{
  readonly bytes: number;
  readonly limit: number;
  readonly raw: string;
}> {
  get message() {
    return `Proof video is ${formatMb(this.bytes)} MB at the lowest quality, over the ${formatMb(this.limit)} MB Size limit, so nothing was downloaded. The raw Recording stays at ${this.raw}; record a shorter walk, or raise --max-size.`;
  }
}

export class RecordingRunningError extends Data.TaggedError(
  "RecordingRunningError",
)<{
  readonly id: string;
}> {
  get message() {
    return `A Recording is already running on ${this.id}; run record stop first`;
  }
}

export class NoRecordingError extends Data.TaggedError("NoRecordingError")<{
  readonly id: string;
}> {
  get message() {
    return `No Recording is running on ${this.id}; run record start first`;
  }
}

export class NothingChangedError extends Data.TaggedError(
  "NothingChangedError",
)<{
  readonly id: string;
  readonly raw: string;
}> {
  get message() {
    return `Recording on ${this.id}: nothing changed on screen, so no Proof video was made. The raw Recording stays at ${this.raw}; check the app is on screen and record again.`;
  }
}

export class CaptureBlockedError extends Data.TaggedError(
  "CaptureBlockedError",
)<{
  readonly id: string;
  readonly what:
    | "the capture stopped"
    | "the capture stalled"
    | "an alert is on screen";
  readonly screenshot?: string | undefined;
}> {
  get message() {
    const saved =
      this.screenshot === undefined
        ? ""
        : `Saved the screen to ${this.screenshot}. `;
    return `Recording on ${this.id} failed: ${this.what}, so no Proof video was made. ${saved}Record the walk again.`;
  }
  get reason() {
    return this.message;
  }
}

export class StopFlagsError extends Data.TaggedError("StopFlagsError")<{
  readonly both: boolean;
}> {
  get message() {
    return this.both
      ? "record stop takes --out <file> or --discard, not both"
      : "record stop needs --out <file>, or --discard to make no Proof video";
  }
}

export class SetupNeedsWorkError extends Data.TaggedError(
  "SetupNeedsWorkError",
)<Record<never, never>> {
  get message() {
    return "--setup needs --work <folder>: the Setup script runs in the Work folder. Nothing was created.";
  }
}

export class SetupScriptMissingError extends Data.TaggedError(
  "SetupScriptMissingError",
)<{
  readonly path: string;
}> {
  get message() {
    return `Setup script ${this.path} not found. Nothing was created.`;
  }
}

export class TokenExposedError extends Data.TaggedError("TokenExposedError")<{
  readonly id: string;
  readonly what:
    | "the token file"
    | "the Docker config token"
    | "the token service";
}> {
  get message() {
    return `Sandbox ${this.id} can reach the Namespace workload token (${this.what}); deleted the host and refused the Sandbox`;
  }
  get reason() {
    return this.message;
  }
}

export class MacPrepareError extends Data.TaggedError("MacPrepareError")<{
  readonly id: string;
  readonly what:
    | "the test screenshot is blocked"
    | "the test capture is blocked"
    | "an alert is on screen"
    | "the Secrets RAM disk cannot be made";
  readonly screenshot?: string | undefined;
}> {
  get message() {
    const saved =
      this.screenshot === undefined
        ? ""
        : `saved the screen to ${this.screenshot} and `;
    return `Sandbox ${this.id} failed the macOS prepare check (${this.what}); ${saved}deleted the Mac`;
  }
  get reason() {
    return this.message;
  }
}

export class EnvFileUnreadableError extends Data.TaggedError(
  "EnvFileUnreadableError",
)<{
  readonly path: string;
  readonly reason: "not found" | "is not readable" | "is a folder";
}> {
  get message() {
    return `Env file ${this.path} ${this.reason}. Nothing was created.`;
  }
}

export class EnvFileLineError extends Data.TaggedError("EnvFileLineError")<{
  readonly path: string;
  readonly line: number;
}> {
  get message() {
    return `Env file ${this.path} line ${this.line} is not NAME=VALUE; fix that line. Nothing was created.`;
  }
}

export class SetupScriptFailedError extends Data.TaggedError(
  "SetupScriptFailedError",
)<{
  readonly code: number;
}> {
  get message() {
    return `Setup script failed with exit code ${this.code}; its last 50 lines are above. Fix the script and create again. This Sandbox was deleted.`;
  }
}

export class BadSizeError extends Data.TaggedError("BadSizeError")<{
  readonly value: string;
}> {
  get message() {
    return `Bad --size "${this.value}": use <cpu>x<ram> in whole numbers, for example 4x8`;
  }
}

export class SizeNotOfferedError extends Data.TaggedError(
  "SizeNotOfferedError",
)<{
  readonly provider: string;
  readonly size: string;
  readonly offered: ReadonlyArray<string>;
}> {
  get message() {
    return `Provider ${this.provider} does not offer the size ${this.size}; use one of: ${this.offered.join(", ")}`;
  }
}

export class ProviderLimitError extends Data.TaggedError("ProviderLimitError")<{
  readonly provider: string;
  readonly limit: string;
}> {
  get message() {
    return `Namespace refused the Sandbox: ${this.limit}; nothing was created. Delete a Sandbox or use a smaller --size`;
  }
  get reason() {
    return this.message;
  }
}

export class MissingCapabilityError extends Data.TaggedError(
  "MissingCapabilityError",
)<{
  readonly provider: string;
  readonly capability: string;
  readonly os?: Os | undefined;
  readonly outcome: string;
}> {
  get message() {
    const on = this.os === undefined ? "" : ` on ${this.os}`;
    return `Provider ${this.provider} lacks the Capability ${this.capability}${on}; ${this.outcome}`;
  }
}

export class BadConfigError extends Data.TaggedError("BadConfigError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message() {
    return `Bad config ${this.path}: ${this.reason}; use JSON like {"linux": "docker", "macos": "namespace"}`;
  }
}

export class BadStepsError extends Data.TaggedError("BadStepsError")<{
  readonly steps: number;
}> {
  get message() {
    return `Bad steps ${this.steps}: scroll needs at least 1`;
  }
}

export class BadSandboxIdError extends Data.TaggedError("BadSandboxIdError")<{
  readonly id: string;
}> {
  get message() {
    return `Bad Sandbox id "${this.id}": use the form <provider>:<name>, for example ns:abc123`;
  }
}

export class UnknownProviderError extends Data.TaggedError(
  "UnknownProviderError",
)<{
  readonly provider: string;
  readonly known: ReadonlyArray<string>;
  readonly id?: string;
}> {
  get message() {
    if (this.id !== undefined) {
      return `Unknown Provider "${this.provider}" in Sandbox id "${this.id}": use the form <provider>:<name> with a Provider from: ${this.known.join(
        ", ",
      )}`;
    }
    return `Unknown Provider "${this.provider}": use one of: ${this.known.join(
      ", ",
    )}`;
  }
}
