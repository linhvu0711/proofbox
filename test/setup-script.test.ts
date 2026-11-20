import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Layer, Ref } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { Style } from "../src/style.ts";
import { cleanupEnvs, makeGitFolder } from "./support/cli.ts";
import { nodeFs } from "./support/node-fs.ts";

const tempRoots: string[] = [];

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix),
  );
  tempRoots.push(dir);
  return dir;
};

// A fake Provider whose delete adds one to `deletes` each time it runs.
const layers = (deletes: Ref.Ref<number>) => {
  const base = makeFakeProvider({
    fs: nodeFs,
    root: tempDir("proofbox-fake-"),
    watch: "none",
  });
  const provider: Provider = {
    ...base,
    delete: (sandbox) =>
      Ref.update(deletes, (count) => count + 1).pipe(
        Effect.zipRight(base.delete(sandbox)),
      ),
  };
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([["fake", providerEntry(provider)]]),
  );
  // Its own runtime dir and no HOME: create marks itself nowhere real.
  const runtime = tempDir("proofbox-runtime-");
  return Layer.mergeAll(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
    ),
    NodeContext.layer,
    CliOutput.Test,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
        note: () => Effect.void,
        done: () => Effect.void,
        hint: () => Effect.void,
      }),
    ),
    Style.Default.pipe(Layer.provide(CliOutput.Test)),
  );
};

describe("Setup script", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    cleanupEnvs();
  });

  it.effect(
    "a failed Setup script prints its lines and deletes the Sandbox once",
    () =>
      Effect.gen(function* () {
        // Given: a fake Provider that counts deletes, a Work folder, and a
        // Setup script that prints two lines, then exits 3
        const deletes = yield* Ref.make(0);
        const work = makeGitFolder({ committed: { "a.txt": "a\n" } });
        const script = join(tempDir("proofbox-setup-"), "setup.sh");
        writeFileSync(script, "#!/bin/sh\necho one\necho two\nexit 3\n");
        // When
        const result = yield* Effect.gen(function* () {
          const error = yield* createSandbox({
            os: "linux",
            provider: "fake",
            work,
            setup: script,
          }).pipe(Effect.flip);
          const output = yield* CliOutput;
          return {
            error: { tag: error._tag, code: "code" in error ? error.code : -1 },
            stderr: Chunk.toReadonlyArray(
              yield* Ref.get(output.captured.err),
            ).join(""),
          };
        }).pipe(Effect.provide(layers(deletes)));
        // Then
        expect({ ...result, deletes: yield* Ref.get(deletes) }).toEqual({
          error: { tag: "SetupScriptFailedError", code: 3 },
          stderr: "one\ntwo\n",
          deletes: 1,
        });
      }),
  );
});
