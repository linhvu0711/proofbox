import { Effect } from "effect";
import { SetupEnvLineError, UploadFailedError } from "./errors.ts";
import {
  readSandboxFile,
  type SandboxFiles,
  writeSandboxFile,
} from "./sandbox-file.ts";
import { envBody, parseEnvLines } from "./secrets.ts";

// The Setup script gets $PROOFBOX_ENV, an empty file it may add NAME=value
// lines to, the way GitHub Actions gives a step $GITHUB_ENV.
export const withProofboxEnv = (
  files: Pick<SandboxFiles, "setupEnvRaw">,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  'PROOFBOX_ENV="$1"; export PROOFBOX_ENV; : > "$1" && shift && exec "$@"',
  "sh",
  files.setupEnvRaw,
  ...argv,
];

// Reads what the Setup script wrote once, checks it with the Secrets file
// rules, and keeps a quoted copy that every exec loads (ADR 0023).
export const keepSetupEnv = Effect.fn("setupEnv.keepSetupEnv")(function* (
  rawId: string,
  files: Pick<SandboxFiles, "setupEnvRaw" | "setupEnv">,
) {
  const read = yield* readSandboxFile(rawId, files.setupEnvRaw);
  if (read.code !== 0) {
    return yield* new UploadFailedError({
      id: rawId,
      command: "sh",
      code: read.code,
    });
  }
  const entries = yield* parseEnvLines("$PROOFBOX_ENV", read.text).pipe(
    Effect.catchTag("SecretsFileLineError", (error) =>
      Effect.fail(new SetupEnvLineError({ line: error.line })),
    ),
  );
  const written = yield* writeSandboxFile(
    rawId,
    files.setupEnv,
    new TextEncoder().encode(envBody(entries)),
    { executable: false },
  );
  if (written !== 0) {
    return yield* new UploadFailedError({
      id: rawId,
      command: "sh",
      code: written,
    });
  }
});

// The names in the Setup env the Sandbox holds, from a Setup script that
// just ran or from a reused Snapshot; none when it has no Setup env.
export const setupEnvNames = Effect.fn("setupEnv.setupEnvNames")(function* (
  rawId: string,
  files: Pick<SandboxFiles, "setupEnv">,
) {
  const read = yield* readSandboxFile(rawId, files.setupEnv);
  if (read.code !== 0) {
    return yield* new UploadFailedError({
      id: rawId,
      command: "sh",
      code: read.code,
    });
  }
  return read.text
    .split("\n")
    .flatMap(
      (line) => /^export ([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? [],
    );
});
