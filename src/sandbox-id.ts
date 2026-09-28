import { randomInt } from "node:crypto";
import { Effect } from "effect";
import { BadSandboxIdError, UnknownProviderError } from "./errors.ts";
import type { Provider } from "./provider.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const makeSandboxName = (length = 6) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const ID_PATTERN = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export interface SandboxId {
  readonly provider: string;
  readonly name: string;
}

export const formatSandboxId = (id: SandboxId) => `${id.provider}:${id.name}`;

export const parseSandboxId = (
  raw: string,
  known: ReadonlyArray<string>,
): Effect.Effect<SandboxId, BadSandboxIdError | UnknownProviderError> =>
  Effect.gen(function* () {
    const match = ID_PATTERN.exec(raw);
    if (match === null) {
      return yield* new BadSandboxIdError({ id: raw });
    }
    const provider = match[1] as string;
    const name = match[2] as string;
    if (!known.includes(provider)) {
      return yield* new UnknownProviderError({
        provider,
        id: raw,
        known,
      });
    }
    return { provider, name };
  });

export interface ResolvedSandboxId {
  readonly provider: Provider;
  readonly prefix: string;
  readonly name: string;
}

export const resolveSandboxId = (
  raw: string,
  providers: ReadonlyMap<string, Provider>,
): Effect.Effect<ResolvedSandboxId, BadSandboxIdError | UnknownProviderError> =>
  Effect.gen(function* () {
    const parsed = yield* parseSandboxId(
      raw,
      [...providers.values()].map((provider) => provider.idPrefix),
    );
    const provider = [...providers.values()].find(
      (candidate) => candidate.idPrefix === parsed.provider,
    );
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`prefix ${parsed.provider} parsed but maps to no Provider`),
      );
    }
    return { provider, prefix: parsed.provider, name: parsed.name };
  });
