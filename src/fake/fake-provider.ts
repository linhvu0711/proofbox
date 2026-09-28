import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Layer, Schema } from "effect";
import { ProviderError } from "../errors.ts";
import { Os, type Provider, Providers, SandboxInfo } from "../provider.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const makeName = () =>
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );

class SandboxFile extends Schema.Class<SandboxFile>("SandboxFile")({
  os: Os,
  createdAt: Schema.Date,
}) {}

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const isAlreadyExists = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "EEXIST";

export const makeFakeProvider = (options: {
  readonly root: string;
  readonly watch: "process" | "none";
}): Provider => {
  const root = options.root;
  const fail = (reason: string) =>
    new ProviderError({ provider: "fake", reason });

  const create = (req: { readonly os: Os }) =>
    Effect.gen(function* () {
      let name: string | undefined;
      for (let i = 0; i < 5 && name === undefined; i++) {
        const candidate = makeName();
        const made = yield* Effect.tryPromise({
          try: async () => {
            await mkdir(join(root, candidate));
            return true;
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            isAlreadyExists(cause)
              ? Effect.succeed(false)
              : Effect.fail(fail(describe(cause))),
          ),
        );
        if (made) name = candidate;
      }
      if (name === undefined) {
        return yield* fail("could not make a Sandbox name after 5 tries");
      }
      const dir = join(root, name);
      const info = new SandboxInfo({
        name,
        os: req.os,
        createdAt: new Date(),
      });
      const file = new SandboxFile({ os: info.os, createdAt: info.createdAt });
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(
            join(dir, "sandbox.json"),
            `${JSON.stringify(Schema.encodeSync(SandboxFile)(file))}\n`,
          );
          await mkdir(join(dir, "home"));
        },
        catch: (cause) => fail(describe(cause)),
      });
      return info;
    });

  return {
    name: "fake",
    capabilities: new Set(["os:linux"]),
    create,
  };
};

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const root = yield* Config.string("PROOFBOX_FAKE_ROOT").pipe(
      Config.withDefault(join(homedir(), ".local/share/proofbox/fake")),
    );
    const providers = new Map<string, Provider>([
      ["fake", makeFakeProvider({ root, watch: "process" })],
    ]);
    return providers;
  }),
);
