import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { BadConfigError } from "./errors.ts";
import { type Os, Providers } from "./provider.ts";

const ConfigFile = Schema.Struct({
  linux: Schema.optional(Schema.String),
  macos: Schema.optional(Schema.String),
});

const KNOWN_KEYS = new Set(["linux", "macos"]);

const providerReason = (os: Os) => `"${os}" must be a Provider name`;

// The config file maps each OS to a Provider name; no file means namespace.
export const providerForOs = (os: Os) =>
  Effect.gen(function* () {
    const home = yield* Config.string("HOME");
    const path = join(home, ".config", "proofbox", "config");
    const bad = (reason: string) => new BadConfigError({ path, reason });
    const text = yield* Effect.tryPromise(() =>
      readFile(path, "utf8"),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) {
      return "namespace";
    }
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => bad("not JSON"),
    });
    if (typeof json !== "object" || json === null) {
      return yield* bad("not JSON");
    }
    for (const key of Object.keys(json)) {
      if (!KNOWN_KEYS.has(key)) {
        return yield* bad(`unknown key "${key}"`);
      }
    }
    const parsed = yield* Schema.decodeUnknown(ConfigFile, {
      onExcessProperty: "error",
    })(json).pipe(Effect.mapError(() => bad(providerReason(os))));
    const name = parsed[os] ?? "namespace";
    const providers = yield* Providers;
    if (!providers.has(name)) {
      return yield* bad(providerReason(os));
    }
    return name;
  });
