import { Effect } from "effect";
import { BadSandboxIdError, UnknownProviderError } from "./errors.ts";

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
