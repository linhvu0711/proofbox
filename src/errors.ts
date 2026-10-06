import type { PlatformError } from "@effect/platform/Error";
import { Data, type Duration } from "effect";
import { formatWait } from "./format-time.ts";
import type { Os } from "./provider.ts";
import { formatMb } from "./upload/max-size.ts";

// The text of a file failure for a ProviderError reason: the Node message,
// as it read before file access went through `FileSystem`, whose own
// message puts the reason, module, method, and path in front of it.
export const platformReason = (error: PlatformError) =>
  error.description ?? error.message;

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
  // The Provider still holds the machine, but create never made it into
  // a Sandbox: an Unfinished Sandbox.
  readonly unfinished?: boolean | undefined;
}> {
  get message() {
    return `Sandbox ${this.id} is gone`;
  }
}

// The Keeper closed or broke the connection before its last frame. It may
// have read the request, so the request never goes again. `reason` is the
// socket error's message; a plain close has none, and the reader of the
// reply says what it waited for.
export class KeeperLostError extends Data.TaggedError("KeeperLostError")<{
  readonly reason?: string | undefined;
}> {}

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
    return `Bad Step mark "${this.label}": use one line of text, for example "step 3: save the post"`;
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
    return `Proof video is ${formatMb(this.bytes)} MB at the lowest quality, over the ${formatMb(this.limit)} MB Size limit, so nothing was downloaded. The raw Recording stays at ${this.raw}; make a shorter Recording, or raise --max-size.`;
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
    | "sshd cannot be turned on"
    | "sshd cannot be reached"
    | "the test screenshot is blocked"
    | "the test capture is blocked"
    | "an alert is on screen"
    | "the Secrets RAM disk cannot be made"
    | "the display can still sleep"
    | "the login password is not runner"
    | "the login keychain does not unlock with runner"
    | "Apple Events to System Events are blocked";
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

export class SecretsFileUnreadableError extends Data.TaggedError(
  "SecretsFileUnreadableError",
)<{
  readonly path: string;
  readonly reason: "not found" | "is not readable" | "is a folder";
}> {
  get message() {
    return `Secrets file ${this.path} ${this.reason}. Nothing was created.`;
  }
}

export class SecretsFileLineError extends Data.TaggedError(
  "SecretsFileLineError",
)<{
  readonly path: string;
  readonly line: number;
}> {
  get message() {
    return `Secrets file ${this.path} line ${this.line} is not NAME=VALUE; fix that line. Nothing was created.`;
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

export class SetupEnvLineError extends Data.TaggedError("SetupEnvLineError")<{
  readonly line: number;
}> {
  get message() {
    return `$PROOFBOX_ENV line ${this.line} is not NAME=VALUE; fix the Setup script and create again. This Sandbox was deleted.`;
  }
}

export class SetupEnvClashError extends Data.TaggedError("SetupEnvClashError")<{
  readonly name: string;
  readonly path: string;
}> {
  get message() {
    return `${this.name} is in both the Setup env and the Secrets file ${this.path}; remove it from one and create again. This Sandbox was deleted.`;
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
    return `Bad Sandbox id "${this.id}": use the form <provider>:<name>, for example ns:us:abc123`;
  }
}

export class NoRegionError extends Data.TaggedError("NoRegionError")<{
  readonly id: string;
}> {
  get message() {
    return `Sandbox id "${this.id}" has no region: use the form ns:<region>:<name>, for example ns:us:abc123`;
  }
}

export class TokenRejectedError extends Data.TaggedError("TokenRejectedError")<{
  readonly provider: string;
}> {
  get message() {
    return `${this.provider.charAt(0).toUpperCase()}${this.provider.slice(1)} did not accept this token. It may be wrong, revoked, or expired.`;
  }
  get reason() {
    return this.message;
  }
}

export class TokenPermissionError extends Data.TaggedError(
  "TokenPermissionError",
)<{
  readonly provider: string;
  readonly call: string;
  readonly need?: string;
}> {
  get message() {
    return `This ${this.provider.charAt(0).toUpperCase()}${this.provider.slice(1)} token lacks permission for ${this.call}. Use a token that can ${this.need ?? "manage instances"}.`;
  }
  get reason() {
    return this.message;
  }
}

export class TokenDeniedError extends Data.TaggedError("TokenDeniedError")<{
  readonly provider: string;
}> {
  get message() {
    return `Your ${this.provider.charAt(0).toUpperCase()}${this.provider.slice(1)} account cannot make tokens. Ask a workspace admin.`;
  }
}

export class BadLoginsFileError extends Data.TaggedError("BadLoginsFileError")<{
  readonly path: string;
  readonly reason: string;
}> {
  get message() {
    return `Bad logins file ${this.path}: ${this.reason}; delete it and log in again`;
  }
}

export class LoginsBusyError extends Data.TaggedError("LoginsBusyError")<{
  readonly lockDir: string;
}> {
  get message() {
    return `Another proofbox command holds ${this.lockDir}. Try again, or delete it if no other proofbox runs.`;
  }
}

export class NotLoggedInError extends Data.TaggedError("NotLoggedInError")<{
  readonly provider: string;
}> {
  get message() {
    return `Not logged in to ${this.provider}. Run: proofbox auth login ${this.provider}`;
  }
  get reason() {
    return this.message;
  }
}

export class LoginExpiredError extends Data.TaggedError("LoginExpiredError")<{
  readonly provider: string;
}> {
  get message() {
    return `Your Provider login for ${this.provider} expired. Run: proofbox auth login ${this.provider}`;
  }
  get reason() {
    return this.message;
  }
}

export class LoginTimeoutError extends Data.TaggedError("LoginTimeoutError")<{
  readonly provider: string;
  readonly wait: string;
}> {
  get message() {
    return `The browser login did not finish in ${this.wait}. Run: proofbox auth login ${this.provider}`;
  }
  get reason() {
    return this.message;
  }
}

// A helper call got no answer within its limit; the helper call it ran
// under decides whether to try again (ADR 0019).
export class AnswerTimeoutError extends Data.TaggedError("AnswerTimeoutError")<{
  readonly after: Duration.Duration;
}> {
  get message() {
    return `No answer in ${formatWait(this.after)}`;
  }
}

export class NoAnswerError extends Data.TaggedError("NoAnswerError")<{
  readonly id: string;
  readonly call: string;
  readonly wait: string;
  // read: tried twice; act: may have happened, never tried again;
  // download: no new bytes, tried twice.
  readonly kind: "read" | "act" | "download";
  readonly log: string;
}> {
  get message() {
    if (this.kind === "act") {
      return `Sandbox ${this.id} did not answer the ${this.call} in ${this.wait}. The ${this.call} may have happened; take a screenshot to check before you try again. Keeper log: ${this.log}`;
    }
    return this.kind === "read"
      ? `Sandbox ${this.id} did not answer the ${this.call} in ${this.wait}, twice. Try again in a minute. Keeper log: ${this.log}`
      : `Sandbox ${this.id} sent no bytes of the ${this.call} for ${this.wait}, twice. Try again in a minute. Keeper log: ${this.log}`;
  }
}

export class NoSuchProviderError extends Data.TaggedError(
  "NoSuchProviderError",
)<{
  readonly provider: string;
  readonly known: ReadonlyArray<string>;
}> {
  get message() {
    return `No provider named "${this.provider}". Providers: ${this.known.join(", ")}.`;
  }
}

export class NoLoginNeededError extends Data.TaggedError("NoLoginNeededError")<{
  readonly provider: string;
}> {
  get message() {
    return `${this.provider} needs no login.`;
  }
}

export class NoLoginWayError extends Data.TaggedError("NoLoginWayError")<{
  readonly provider: string;
  readonly way: string;
}> {
  get message() {
    return `${this.provider} has no ${this.way} login. Use --token.`;
  }
}

export class NoTokenError extends Data.TaggedError("NoTokenError")<{
  readonly provider: string;
}> {
  get message() {
    return `No token on stdin. Run: echo <token> | proofbox auth login ${this.provider} --token`;
  }
}

export class NoTokenMakingError extends Data.TaggedError("NoTokenMakingError")<{
  readonly provider: string;
}> {
  get message() {
    return `${this.provider} cannot make tokens.`;
  }
}

export class BadTokenFlagError extends Data.TaggedError("BadTokenFlagError")<{
  readonly flag: "name" | "expires";
}> {
  get message() {
    return this.flag === "name"
      ? "--name is required (for example ci)."
      : "--expires is required (for example 30d, at most 1y).";
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

export class UnknownRegionError extends Data.TaggedError("UnknownRegionError")<{
  readonly provider: string;
  readonly region: string;
  readonly known: ReadonlyArray<string>;
  readonly id?: string;
}> {
  get message() {
    if (this.id !== undefined) {
      return `Unknown region "${this.region}" in Sandbox id "${this.id}": use one of: ${this.known.join(
        ", ",
      )}`;
    }
    return `Unknown region "${this.region}" for ${this.provider}: use one of: ${this.known.join(
      ", ",
    )}`;
  }
}

export class NoRegionsError extends Data.TaggedError("NoRegionsError")<{
  readonly provider: string;
}> {
  get message() {
    return `${this.provider} has no regions. Log in without --region.`;
  }
}
