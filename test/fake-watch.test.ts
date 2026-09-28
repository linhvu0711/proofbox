import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { afterEach, describe, expect } from "vitest";
import { SandboxFile } from "../src/fake/fake-provider.ts";
import { watchSandbox } from "../src/fake/watch.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wholeFile = (deadline: Date) =>
  `${JSON.stringify(
    Schema.encodeSync(SandboxFile)(
      new SandboxFile({
        os: "linux",
        createdAt: new Date(Date.now() - 60_000),
        idleSeconds: 2,
        deadline,
        maxLifeAt: new Date(Date.now() + 3_600_000),
      }),
    ),
  )}\n`;

describe("fake watcher", () => {
  afterEach(cleanupEnvs);

  it("the fake deletes a Sandbox at its Deadline with no Caller", async () => {
    // Given: a Sandbox with a 2-second idle deadline; the create CLI has exited
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--idle",
      "2s",
    ]);
    const id = created.stdout.trim();
    const dir = join(env.root, id.slice("fake:".length));
    // When: poll every 200 ms, up to 8 s
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(200);
      gone = !existsSync(dir);
    }
    // Then
    expect(gone).toBe(true);
    const result = await runCli(env, ["exec", id, "--", "true"]);
    expect(result.stderr).toBe(`Sandbox ${id} is gone\n`);
    expect(result.exitCode).toBe(125);
  });

  it.live(
    "the watcher reads a half-written sandbox.json again and deletes the Sandbox at its Deadline",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox folder whose sandbox.json is half written
        const env = makeEnv();
        const dir = join(env.root, "abc123");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "sandbox.json"), '{"deadline":');
        // When: the watcher runs past one retry, then the file becomes whole
        const fiber = yield* Effect.fork(watchSandbox(env.root, "abc123"));
        yield* Effect.sleep("1500 millis");
        const early = yield* Fiber.poll(fiber);
        const stillThere = existsSync(dir);
        writeFileSync(
          join(dir, "sandbox.json"),
          wholeFile(new Date(Date.now() - 1000)),
        );
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeout("3 seconds"),
        );
        // Then
        expect(Option.isNone(early)).toBe(true);
        expect(stillThere).toBe(true);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(existsSync(dir)).toBe(false);
      }),
  );
});
