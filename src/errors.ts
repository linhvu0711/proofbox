import { Data } from "effect";
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
  readonly tag: string;
}> {
  get message() {
    return `Tool bundle file ${this.file} has the wrong hash; deleted ${this.sandboxId}. Run docker image rm ${this.tag} and try again`;
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

export class BadMaxSizeError extends Data.TaggedError("BadMaxSizeError")<{
  readonly value: string;
}> {
  get message() {
    return `Bad --max-size "${this.value}": use a whole number with MB or GB, for example 800MB`;
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

export class MissingCapabilityError extends Data.TaggedError(
  "MissingCapabilityError",
)<{
  readonly provider: string;
  readonly capability: string;
  readonly outcome: string;
}> {
  get message() {
    return `Provider ${this.provider} lacks the Capability ${this.capability}; ${this.outcome}`;
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
    return `Bad Sandbox id "${this.id}": use the form <provider>:<name>, for example fake:abc123`;
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
