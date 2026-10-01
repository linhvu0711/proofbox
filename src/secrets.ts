import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { CliOutput } from "./cli-output.ts";
import { withDeadlinePush } from "./deadline.ts";
import {
  EnvFileLineError,
  EnvFileUnreadableError,
  ProviderError,
  SecretsSendFailedError,
} from "./errors.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { writeSandboxFile } from "./sandbox-file.ts";
import { resolveSandboxId } from "./sandbox-id.ts";
import { shellJoin } from "./shell.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const Secret = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(NAME)),
  value: Schema.RedactedFromSelf(Schema.String),
});
export type Secret = typeof Secret.Type;

export const parseEnvFile = Effect.fn("secrets.parseEnvFile")(function* (
  path: string,
  text: string,
) {
  const secrets: Array<Secret> = [];
  let lineNumber = 0;
  for (const raw of text.split("\n")) {
    lineNumber += 1;
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export".length).trimStart();
    }
    const at = line.indexOf("=");
    const name = line.slice(0, at).trim();
    if (at === -1 || !NAME.test(name)) {
      return yield* new EnvFileLineError({ path, line: lineNumber });
    }
    const rawValue = line.slice(at + 1);
    const trimmed = rawValue.trimStart();
    const quote = trimmed.at(0);
    const quoted = quote === '"' || quote === "'";
    const close = quoted ? trimmed.indexOf(quote, 1) : -1;
    let value: string;
    if (quoted && close === -1) {
      // A value that opens a quote must close it on the same line.
      return yield* new EnvFileLineError({ path, line: lineNumber });
    } else if (close !== -1) {
      // A quoted value keeps its `#`; after the closing quote only a
      // comment may follow (Docker Compose's rule).
      if (!/^\s*(?:#.*)?$/.test(trimmed.slice(close + 1))) {
        return yield* new EnvFileLineError({ path, line: lineNumber });
      }
      value = trimmed.slice(1, close);
    } else {
      // An unquoted value ends at a space or tab followed by `#`.
      const cut = rawValue.search(/[ \t]#/);
      value = (cut === -1 ? rawValue : rawValue.slice(0, cut)).trim();
    }
    const secret: Secret = { name, value: Redacted.make(value) };
    const existing = secrets.findIndex((known) => known.name === name);
    if (existing === -1) {
      secrets.push(secret);
    } else {
      secrets[existing] = secret;
    }
  }
  return secrets;
});

const envFileError = (path: string) => (cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined;
  switch (code) {
    case "ENOENT":
      return new EnvFileUnreadableError({ path, reason: "not found" });
    case "EACCES":
      return new EnvFileUnreadableError({ path, reason: "is not readable" });
    case "EISDIR":
      return new EnvFileUnreadableError({ path, reason: "is a folder" });
    default:
      return new ProviderError({
        provider: "local",
        reason: cause instanceof Error ? cause.message : String(cause),
      });
  }
};

export const readEnvFile = Effect.fn("secrets.readEnvFile")(function* (
  path: string,
) {
  const onError = envFileError(path);
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: onError,
  });
  const info = yield* Effect.tryPromise({
    try: () => stat(path),
    catch: onError,
  });
  if ((info.mode & 0o077) !== 0) {
    const output = yield* CliOutput;
    yield* output.err(
      `proofbox: env file ${path} is mode ${(info.mode & 0o777).toString(8)}, so other users can read it; run chmod 600 ${path}\n`,
    );
  }
  return yield* parseEnvFile(path, text);
});

export const sendSecrets = Effect.fn("secrets.sendSecrets")(function* (
  rawId: string,
  secrets: ReadonlyArray<Secret>,
) {
  const providers = yield* Providers;
  const id = yield* resolveSandboxId(rawId, providers);
  const provider = id.provider;
  const info = yield* provider.get(id);
  const progress = yield* Progress;
  const body = secrets
    .map(
      (secret) =>
        `export ${secret.name}=${shellJoin([Redacted.value(secret.value)])}\n`,
    )
    .join("");
  yield* progress.step(
    `sending ${secrets.length} ${secrets.length === 1 ? "Secret" : "Secrets"}`,
    withDeadlinePush(
      provider,
      id,
      info,
    )(
      Effect.gen(function* () {
        const code = yield* writeSandboxFile(
          rawId,
          posix.join(provider.secretsDir(id.name, info.os), "env"),
          new TextEncoder().encode(body),
          { executable: false },
        );
        if (code !== 0) {
          return yield* new SecretsSendFailedError({ id: rawId, code });
        }
      }),
    ),
  );
});

export const withSecrets = (
  envPath: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  'set +x; if [ -r "$1" ]; then . "$1"; fi; shift; exec "$@"',
  "sh",
  envPath,
  ...argv,
];
