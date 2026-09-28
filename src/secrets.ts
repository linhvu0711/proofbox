import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Effect, Redacted } from "effect";
import { withDeadlinePush } from "./deadline.ts";
import { ProviderError, SecretsSendFailedError } from "./errors.ts";
import { Progress } from "./progress.ts";
import { Providers } from "./provider.ts";
import { writeSandboxFile } from "./sandbox-file.ts";
import { parseSandboxId } from "./sandbox-id.ts";
import { shellJoin } from "./shell.ts";

export interface Secret {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export const parseEnvFile = (
  _path: string,
  text: string,
): ReadonlyArray<Secret> => {
  const secrets: Array<Secret> = [];
  for (const raw of text.split("\n")) {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export".length).trimStart();
    }
    const at = line.indexOf("=");
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    const quote = value.at(0);
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
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
};

export const readEnvFile = (path: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new ProviderError({
          provider: "local",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return parseEnvFile(path, text);
  });

export const sendSecrets = (rawId: string, secrets: ReadonlyArray<Secret>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    const info = yield* provider.get(id.name);
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
        id.name,
        info,
      )(
        Effect.gen(function* () {
          const code = yield* writeSandboxFile(
            rawId,
            posix.join(provider.secretsDir(id.name), "env"),
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
  'if [ -r "$1" ]; then . "$1"; fi; shift; exec "$@"',
  "sh",
  envPath,
  ...argv,
];
