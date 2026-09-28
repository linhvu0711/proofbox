import { Data } from "effect";

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

export class UnknownProviderError extends Data.TaggedError(
  "UnknownProviderError",
)<{
  readonly provider: string;
  readonly known: ReadonlyArray<string>;
}> {
  get message() {
    return `Unknown Provider "${this.provider}": use one of: ${this.known.join(
      ", ",
    )}`;
  }
}
