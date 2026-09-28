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
}> {
  get message() {
    return `Bad --${this.flag} "${this.value}": use a whole number with s, m, or h, for example 15m`;
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

export class MissingCapabilityError extends Data.TaggedError(
  "MissingCapabilityError",
)<{
  readonly provider: string;
  readonly capability: string;
}> {
  get message() {
    return `Provider ${this.provider} lacks the Capability ${this.capability}; nothing was created`;
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
