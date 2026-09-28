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
