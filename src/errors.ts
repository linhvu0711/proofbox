import { Data } from "effect";

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
}> {
  get message() {
    return `Bad --${this.flag} "${this.value}": use a whole number with s, m, or h, for example 15m`;
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
