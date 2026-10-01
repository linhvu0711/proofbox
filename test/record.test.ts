import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Duration, Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { stopRecording } from "../src/commands/record.ts";
import { CaptureBlockedError } from "../src/errors.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const tempRoots: string[] = [];

// A fake Sandbox that reports itself as a Mac, whose exec answers
// `/opt/proofbox/record stop` with a blocked-capture report and `fetch`
// with one PNG header.
const blockedMac = (root: string, blocked: string): Provider => {
  const base = makeFakeProvider({ root, watch: "none" });
  const answer = (argv: ReadonlyArray<string>) => {
    const [, action, remote] = argv;
    if (action === "stop") {
      return Stream.make(
        {
          _tag: "Stdout" as const,
          bytes: new TextEncoder().encode(
            `{"dir":"/var/lib/proofbox/recordings/1","start":1,"stop":5,"steps":0,"width":1280,"height":800,"blocked":"${blocked}"}`,
          ),
        },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    if (
      action === "fetch" &&
      remote === "/var/lib/proofbox/recordings/1/blocked.png"
    ) {
      return Stream.make(
        { _tag: "Stdout" as const, bytes: PNG_HEAD },
        { _tag: "Exit" as const, code: 0 },
      );
    }
    return Stream.make({ _tag: "Exit" as const, code: 1 });
  };
  return {
    ...base,
    offers: {
      ...base.offers,
      macos: {
        sizes: [{ cpu: 4, ramGb: 7 }],
        features: new Set(["desktop", "recording"]),
      },
    },
    connect: (sandbox) =>
      Effect.map(base.connect(sandbox), (connection) => ({
        ...connection,
        exec: (argv) => answer(argv),
      })),
  };
};

const layers = (mac: Provider) => {
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

describe("Recording and the Proof video", () => {
  afterEach(() => {
    cleanupEnvs();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mark refuses a label over 60 characters", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    const label = "a".repeat(61);
    // When
    const result = await runCli(env, ["mark", id, label]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Bad Step mark "${label}": use 1 to 60 characters on one line, for example "step 3: save the post"\n`,
    );
  });

  it("record stop refuses a bad --max-size", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--max-size",
      "10KB",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      'Bad --max-size "10KB": use a whole number with MB or GB, for example 800MB\n',
    );
  });

  it("record stop needs --out or --discard", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["record", "stop", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop needs --out <file>, or --discard to make no Proof video\n",
    );
  });

  it("record stop takes --out or --discard, not both", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      "/tmp/p.mp4",
      "--discard",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "record stop takes --out <file> or --discard, not both\n",
    );
  });

  effectIt.effect(
    "record stop on a blocked Mac capture names it and downloads the screen",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const mac = blockedMac(root, "the capture stopped");
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        const dir = mkdtempSync(join(tmpdir(), "proofbox-out-"));
        tempRoots.push(dir);
        // When
        const error = yield* Effect.flip(
          stopRecording({ id, out: join(dir, "proof.mp4") }),
        );
        // Then
        const saved = join(dir, "proof-blocked.png");
        expect(error).toBeInstanceOf(CaptureBlockedError);
        expect(error.message).toBe(
          `Recording on ${id} failed: the capture stopped, so no Proof video was made. Saved the screen to ${saved}. Record the walk again.`,
        );
        expect(new Uint8Array(readFileSync(saved))).toEqual(PNG_HEAD);
      }).pipe(Effect.provide(layers(mac)));
    },
  );

  effectIt.effect(
    "record stop --discard on a blocked Mac capture still names it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      const mac = blockedMac(root, "the capture stalled");
      return Effect.gen(function* () {
        // Given: the stub Mac above
        const info = yield* mac.create({
          os: "macos",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        });
        const id = `fake:${info.name}`;
        // When
        const error = yield* Effect.flip(stopRecording({ id, discard: true }));
        // Then
        expect(error).toBeInstanceOf(CaptureBlockedError);
        expect(
          error.message.startsWith(
            `Recording on ${id} failed: the capture stalled, so no Proof video was made.`,
          ),
        ).toBe(true);
        rmSync(join(process.cwd(), "proof-blocked.png"), { force: true });
      }).pipe(Effect.provide(layers(mac)));
    },
  );
});
