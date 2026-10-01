import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, Effect, Layer, Ref } from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
  SandboxInfo,
} from "../src/provider.ts";

const tempRoots: string[] = [];

// A fake Sandbox that reports itself as a 4x7 Mac, where every memoryKills
// call sees one more kernel kill than the last: some process on the Mac is
// killed while the command runs.
const layers = () => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(root);
  const base = makeFakeProvider({ root, watch: "none" });
  let kills = 0;
  const mac: Provider = {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [
          { cpu: 4, ramGb: 7 },
          { cpu: 6, ramGb: 14 },
        ],
        features: new Set(["desktop"]),
      },
    },
    get: (name) =>
      base.get(name).pipe(
        Effect.map(
          (info) =>
            new SandboxInfo({
              ...info,
              os: "macos",
              size: { cpu: 4, ramGb: 7 },
            }),
        ),
      ),
    memoryKills: () => Effect.sync(() => kills++),
  };
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([["fake", providerEntry(mac)]]),
  );
  return Layer.mergeAll(
    NodeContext.layer,
    CliOutput.Test,
    providers,
    KeeperClient.Direct.pipe(Layer.provide(providers)),
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
      }),
    ),
  );
};

const created = Effect.gen(function* () {
  yield* createSandbox({ os: "linux", provider: "fake" });
  const output = yield* CliOutput;
  const out = yield* Ref.get(output.captured.out);
  yield* Ref.set(output.captured.out, Chunk.empty());
  return Chunk.toReadonlyArray(out).join("").trim();
});

const stderr = Effect.gen(function* () {
  const output = yield* CliOutput;
  return Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join("");
});

describe("exec out of memory on a Mac", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect(
    "a command that exits 0 on a Mac stays a success when another process is killed",
    () =>
      Effect.gen(function* () {
        // Given
        const id = yield* created;
        // When
        yield* execInSandbox(id, ["true"]);
        // Then
        const output = yield* CliOutput;
        expect(yield* output.exitCode).toBe(0);
        expect(yield* stderr).not.toContain("ran out of memory");
      }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "a command killed with SIGKILL on a Mac after a memory kill is out of memory",
    () =>
      Effect.gen(function* () {
        // Given
        const id = yield* created;
        // When
        // (ssh reports a SIGKILLed command as 137)
        yield* execInSandbox(id, ["sh", "-c", "exit 137"]);
        // Then
        const output = yield* CliOutput;
        expect(yield* output.exitCode).toBe(122);
        expect(yield* stderr).toContain(
          "Sandbox ran out of memory (4x7). Try --size 6x14.",
        );
      }).pipe(Effect.provide(layers())),
  );
});
