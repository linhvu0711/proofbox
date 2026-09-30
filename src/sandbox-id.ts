import { randomInt } from "node:crypto";
import { Effect } from "effect";
import {
  BadSandboxIdError,
  NoRegionError,
  UnknownProviderError,
  UnknownRegionError,
} from "./errors.ts";
import type { Provider, SandboxRef } from "./provider.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const makeSandboxName = (length = 6) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

// <provider>:<name>, with an optional <region> between for a Provider
// whose names are regional.
const ID_PATTERN =
  /^([a-z][a-z0-9-]*):(?:([a-z][a-z0-9-]*):)?([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export interface SandboxId {
  readonly provider: string;
  readonly region: string | undefined;
  readonly name: string;
}

export const formatSandboxId = (id: SandboxId) =>
  id.region === undefined
    ? `${id.provider}:${id.name}`
    : `${id.provider}:${id.region}:${id.name}`;

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
    const region = match[2];
    const name = match[3] as string;
    if (!known.includes(provider)) {
      return yield* new UnknownProviderError({
        provider,
        id: raw,
        known,
      });
    }
    return { provider, region, name };
  });

export interface ResolvedSandboxId extends SandboxRef {
  readonly provider: Provider;
  readonly prefix: string;
}

export const resolveSandboxId = (
  raw: string,
  providers: ReadonlyMap<string, Provider>,
): Effect.Effect<
  ResolvedSandboxId,
  BadSandboxIdError | NoRegionError | UnknownProviderError | UnknownRegionError
> =>
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
    if (provider.regions === undefined) {
      if (parsed.region !== undefined) {
        return yield* new BadSandboxIdError({ id: raw });
      }
      return {
        provider,
        prefix: parsed.provider,
        name: parsed.name,
        region: undefined,
      };
    }
    if (parsed.region === undefined) {
      return yield* new NoRegionError({ id: raw });
    }
    if (!provider.regions.known.includes(parsed.region)) {
      return yield* new UnknownRegionError({
        provider: provider.name,
        region: parsed.region,
        known: provider.regions.known,
        id: raw,
      });
    }
    return {
      provider,
      prefix: parsed.provider,
      name: parsed.name,
      region: parsed.region,
    };
  });
