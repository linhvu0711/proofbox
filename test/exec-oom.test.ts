import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Chunk, ConfigProvider, Effect, Layer, Ref } from "effect";
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
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { nodeFs } from "./support/node-fs.ts";

const tempRoots: string[] = [];

// A fake Sandbox of the given OS and size. A command raises its memory-kill
// count with `echo 1 > ../memory-kills`, from the Sandbox's home folder.
const layers = (os: "linux" | "macos" = "macos") => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  tempRoots.push(root);
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const size = os === "macos" ? { cpu: 4, ramGb: 7 } : { cpu: 4, ramGb: 8 };
  const provider: Provider = {
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
      base
        .get(name)
        .pipe(Effect.map((info) => new SandboxInfo({ ...info, os, size }))),
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) => ({
        ...connection,
        info: new SandboxInfo({ ...connection.info, os, size }),
      })),
  };
  const providers = Layer.succeed(
    Providers,
    new Map<string, ProviderEntry>([["fake", providerEntry(provider)]]),
  );
  // Its own runtime dir and no HOME: create marks itself nowhere real,
  // and takes no logins lock in the developer's HOME.
  const runtime = mkdtempSync(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "proofbox-runtime-",
    ),
  );
  tempRoots.push(runtime);
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

describe("exec out of memory", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    cleanupEnvs();
  });

  it("a command killed for memory through a Keeper on the fake Provider exits 122 and names the next size", async () => {
    // Given: a fake Sandbox, its Keeper started by create
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--size",
      "4x8",
    ]);
    const id = created.stdout.trim();
    // When: the command is killed for memory
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "echo 1 > ../memory-kills; exit 137",
    ]);
    // Then
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 122,
      stderr: "Sandbox ran out of memory (4x8). Try --size 8x16.\n",
    });
  });

  it.effect(
    "a command that exits 0 on a Mac stays a success when another process is killed",
    () =>
      Effect.gen(function* () {
        // Given
        const id = yield* created;
        // When: some other process is killed while the command runs
        yield* execInSandbox(id, ["sh", "-c", "echo 1 > ../memory-kills"]);
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
        yield* execInSandbox(id, [
          "sh",
          "-c",
          "echo 1 > ../memory-kills; exit 137",
        ]);
        // Then
        const output = yield* CliOutput;
        expect(yield* output.exitCode).toBe(122);
        expect(yield* stderr).toContain(
          "Sandbox ran out of memory (4x7). Try --size 6x14.",
        );
      }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "a command that exits 0 on Linux after a new kill is out of memory",
    () =>
      Effect.gen(function* () {
        // Given
        const id = yield* created;
        // When: some other process is killed while the command runs
        yield* execInSandbox(id, ["sh", "-c", "echo 1 > ../memory-kills"]);
        // Then
        const output = yield* CliOutput;
        expect(yield* output.exitCode).toBe(122);
        expect(yield* stderr).toContain(
          "Sandbox ran out of memory (4x8). Try --size 8x16.",
        );
      }).pipe(Effect.provide(layers("linux"))),
  );
});
