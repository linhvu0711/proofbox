import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Chunk, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { openLive } from "../src/commands/live.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { Progress } from "../src/progress.ts";
import {
  type Provider,
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { nodeFs } from "./support/node-fs.ts";

const tempRoots: string[] = [];

// A fake Provider that offers a Live view on Linux. Only Namespace has a
// real one, so `openLive` is tested here with this stub.
const withLiveView = (root: string): Provider => {
  const base = makeFakeProvider({ fs: nodeFs, root, watch: "none" });
  const linux = base.offers.linux;
  if (linux === undefined) {
    throw new Error("the fake Provider offers no linux");
  }
  return {
    ...base,
    offers: {
      ...base.offers,
      linux: { ...linux, features: new Set([...linux.features, "live-view"]) },
    },
    liveView: () =>
      Effect.succeed({
        address: "127.0.0.1:5901",
        password: "pw1234",
        gone: Effect.never,
      }),
  };
};

const layers = (provider: Provider) =>
  Layer.mergeAll(
    NodeContext.layer,
    CliOutput.Test,
    Layer.succeed(
      Providers,
      new Map<string, ProviderEntry>([["fake", providerEntry(provider)]]),
    ),
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
        note: () => Effect.void,
        hint: () => Effect.void,
      }),
    ),
  );

// Opens the Live view, waits for its stdout, then interrupts it as Ctrl-C
// does, and gives back what it printed.
const liveOutput = (provider: Provider, json: boolean) =>
  Effect.gen(function* () {
    const info = yield* provider.create({
      os: "linux",
      idle: Duration.minutes(5),
      maxLife: Duration.hours(1),
    });
    const output = yield* CliOutput;
    const fiber = yield* Effect.fork(openLive(`fake:${info.name}`, { json }));
    yield* Ref.get(output.captured.out).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(10)),
        until: (chunks) => Chunk.size(chunks) > 0,
      }),
    );
    yield* Fiber.interrupt(fiber);
    return Chunk.join(yield* Ref.get(output.captured.out), "");
  }).pipe(Effect.provide(layers(provider)));

describe("live", () => {
  afterEach(() => {
    cleanupEnvs();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it("live on a Provider with no Live view is refused", async () => {
    // Given: a fake Sandbox — fake offers no Live view
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
    const result = await runCli(env, ["live", id]);
    // Then
    expect(result.stderr).toBe(
      "Provider fake lacks the Capability live-view; no Live view was opened\n",
    );
    expect(result.exitCode).toBe(125);
  });

  effectIt.live(
    "live --json prints the address and password as one JSON line and stays open",
    () => {
      // Given: the stub Live view above
      const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
      tempRoots.push(root);
      return Effect.gen(function* () {
        // When
        const stdout = yield* liveOutput(withLiveView(root), true);
        // Then
        expect(stdout).toBe(
          '{"address":"127.0.0.1:5901","password":"pw1234"}\n',
        );
      });
    },
  );

  effectIt.live("live without --json prints the address, then password", () => {
    // Given: the stub Live view above
    const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
    tempRoots.push(root);
    return Effect.gen(function* () {
      // When
      const stdout = yield* liveOutput(withLiveView(root), false);
      // Then
      expect(stdout).toBe("127.0.0.1:5901\npassword pw1234\n");
    });
  });
});
