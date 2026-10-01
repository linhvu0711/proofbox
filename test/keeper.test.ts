import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Duration,
  Effect,
  Ref,
  TestClock,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { runHelper } from "../src/helper.ts";
import { runKeeper } from "../src/keeper/keeper.ts";
import { liveCreates, markCreate, unmarkCreate } from "../src/keeper/paths.ts";
import { Progress } from "../src/progress.ts";
import { type Provider, Providers, providerEntry } from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { startKeeper } from "./support/keeper.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keeperPid = (env: { runtime: string }, name: string) =>
  Number.parseInt(
    readFileSync(join(env.runtime, `fake-${name}.pid`), "utf8").trim(),
    10,
  );

const noProgress = new Progress({
  step: (_label, effect) => effect,
  warn: () => Effect.void,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const runtimeConfig = (env: { runtime: string }) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", env.runtime]])),
  );

// A fake Sandbox made at t=0 with a Keeper run in this process, and the
// layers a command needs to reach it. The Provider counts the `get` and
// `extend` calls made to it from the CLI side; the Keeper's own checks go
// through its Connection and are not counted.
const warmKeeper = (
  env: { root: string; runtime: string },
  options: {
    readonly maxLife?: Duration.Duration;
    readonly desktop?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fake = makeFakeProvider({ root: env.root, watch: "none" });
    const info = yield* fake
      .create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: options.maxLife ?? Duration.hours(3),
      })
      .pipe(Effect.provideService(Progress, noProgress));
    const calls = { get: 0, extend: 0 };
    const linux = fake.offers.linux;
    const counted: Provider = {
      ...fake,
      offers:
        options.desktop === true && linux !== undefined
          ? {
              linux: {
                ...linux,
                features: new Set([...linux.features, "desktop"]),
              },
            }
          : fake.offers,
      get: (ref) =>
        Effect.suspend(() => {
          calls.get += 1;
          return fake.get(ref);
        }),
      extend: (ref, deadline) =>
        Effect.suspend(() => {
          calls.extend += 1;
          return fake.extend(ref, deadline);
        }),
    };
    const id = `fake:${info.name}`;
    const layers = yield* startKeeper(id, counted);
    calls.get = 0;
    calls.extend = 0;
    const deadline = Effect.map(
      fake.get({ name: info.name, region: undefined }),
      (read) => read.deadline.toISOString(),
    );
    return { id, name: info.name, calls, layers, deadline };
  });

const capturedOut = Effect.gen(function* () {
  const output = yield* CliOutput;
  return Chunk.toReadonlyArray(yield* Ref.get(output.captured.out)).join("");
});

describe("Keeper", () => {
  afterEach(cleanupEnvs);

  it("create starts a Keeper", async () => {
    // Given
    const env = makeEnv();
    // When
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    // Then
    const pidFile = join(env.runtime, `fake-${name}.pid`);
    expect(existsSync(pidFile)).toBe(true);
    expect(alive(keeperPid(env, name))).toBe(true);
  });

  it("exec starts a new Keeper after the old one is killed", async () => {
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
    const name = id.slice("fake:".length);
    const oldPid = keeperPid(env, name);
    process.kill(oldPid, "SIGKILL");
    for (let i = 0; i < 50 && alive(oldPid); i++) {
      await sleep(100);
    }
    // When
    const result = await runCli(env, ["exec", id, "--", "echo", "back"]);
    // Then
    expect(result.stdout).toBe("back\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const newPid = keeperPid(env, name);
    expect(newPid).not.toBe(oldPid);
    expect(alive(newPid)).toBe(true);
  });

  it("delete stops the Keeper", async () => {
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
    const name = id.slice("fake:".length);
    const pid = keeperPid(env, name);
    // When
    await runCli(env, ["delete", id]);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(100);
      gone = !alive(pid);
    }
    // Then
    expect(gone).toBe(true);
    expect(existsSync(join(env.runtime, `fake-${name}.sock`))).toBe(false);
    expect(existsSync(join(env.runtime, `fake-${name}.pid`))).toBe(false);
  });

  it("an exec that exits before its input ends does not break the Keeper", async () => {
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
    const name = id.slice("fake:".length);
    const socketPath = join(env.runtime, `fake-${name}.sock`);
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // When: `true` exits at once while the Caller keeps writing input
    socket.write(`${JSON.stringify({ exec: ["true"], stdin: true })}\n`);
    await sleep(500);
    let writeError: Error | undefined;
    socket.on("error", (error) => {
      writeError = error;
    });
    socket.write(
      `${JSON.stringify({ in: Buffer.from("leftover").toString("base64") })}\n`,
      (error) => {
        writeError = error ?? writeError;
      },
    );
    socket.write(`${JSON.stringify({ end: true })}\n`);
    const replies: Array<unknown> = [];
    await new Promise<void>((resolve) => {
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          replies.push(JSON.parse(pending.slice(0, newline)));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    // Then: the input frame landed (no EPIPE), the exit frame came back, and
    // the Keeper still serves
    await sleep(200);
    expect(writeError).toBeUndefined();
    expect(replies).toEqual([{ exit: 0 }]);
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
  });

  it("an exec that exits with a full input Mailbox still drains the client's writes", async () => {
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
    const name = id.slice("fake:".length);
    const socketPath = join(env.runtime, `fake-${name}.sock`);
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // When: the command sleeps 0.2s; the Caller pushes more input than the
    // Mailbox (16) and the process pipe can hold, so an offer is parked
    // when the exec exits; then the end marker follows
    socket.write(
      `${JSON.stringify({ exec: ["sh", "-c", "sleep 0.2"], stdin: true })}\n`,
    );
    const chunk = Buffer.alloc(8192, 0x61).toString("base64");
    for (let i = 0; i < 40; i++) {
      socket.write(`${JSON.stringify({ in: chunk })}\n`);
    }
    socket.write(`${JSON.stringify({ end: true })}\n`);
    // Then: the parked offer wakes, the end marker lands, the socket closes
    const replies: Array<unknown> = [];
    let closed = false;
    let pending = "";
    socket.on("data", (data) => {
      pending += data.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        replies.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    socket.on("close", () => {
      closed = true;
    });
    for (let i = 0; i < 40 && !closed; i++) {
      await sleep(100);
    }
    // The one reply is the exit frame — or an EPIPE fail frame when the
    // pipe fills before sleep exits. Either way the socket must close.
    expect(closed).toBe(true);
    expect(replies.length).toBe(1);
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
  });

  it("a client that disconnects mid-exec does not break the Keeper", async () => {
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
    const name = id.slice("fake:".length);
    const socketPath = join(env.runtime, `fake-${name}.sock`);
    // When: a client starts a long exec and disappears
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ exec: ["sleep", "5"] })}\n`);
    await sleep(300);
    socket.destroy();
    await sleep(300);
    // Then: the Keeper still serves
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
  });

  it("the Keeper stops when its Deadline passes", async () => {
    // Given: a Sandbox with the default idle, so its Keeper starts long
    // before the Deadline
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    const pid = keeperPid(env, name);
    // When: the Deadline passes. Write a temp file and rename it, like the
    // fake does, so the Keeper never reads a half-written sandbox.json.
    const sandboxFile = join(env.root, name, "sandbox.json");
    const meta = JSON.parse(readFileSync(sandboxFile, "utf8"));
    meta.deadline = new Date(Date.now() - 1000).toISOString();
    writeFileSync(`${sandboxFile}.tmp`, `${JSON.stringify(meta)}\n`);
    renameSync(`${sandboxFile}.tmp`, sandboxFile);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(200);
      gone = !alive(pid);
    }
    // Then
    expect(gone).toBe(true);
  });

  it.effect(
    "the Keeper fails with ProviderError when it cannot write its pid file",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox, and a folder where the Keeper's pid file goes
        const env = makeEnv();
        const fake = makeFakeProvider({ root: env.root, watch: "none" });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        mkdirSync(join(env.runtime, `fake-${info.name}.pid`));
        // When
        const error = yield* runKeeper(`fake:${info.name}`).pipe(
          Effect.provideService(
            Providers,
            new Map([["fake", providerEntry(fake)]]),
          ),
          Effect.provide(NodeContext.layer),
          Effect.withConfigProvider(
            ConfigProvider.fromMap(
              new Map([["PROOFBOX_RUNTIME_DIR", env.runtime]]),
            ),
          ),
          Effect.flip,
        );
        // Then
        expect(error).toMatchObject({
          _tag: "ProviderError",
          provider: "fake",
          reason: expect.stringContaining("EISDIR"),
        });
      }),
  );

  it.scoped(
    "a command through a warm Keeper asks the Provider nothing from the CLI",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const keeper = yield* warmKeeper(env);
        // When
        const out = yield* execInSandbox(keeper.id, [
          "sh",
          "-c",
          "echo hi",
        ]).pipe(
          Effect.zipRight(capturedOut),
          Effect.zip(Effect.flatMap(CliOutput, (output) => output.exitCode)),
          Effect.provide(keeper.layers),
        );
        // Then
        expect(out).toEqual(["hi\n", 0]);
        expect(keeper.calls).toEqual({ get: 0, extend: 0 });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through the Keeper pushes the Deadline by the idle time",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const keeper = yield* warmKeeper(env);
        yield* TestClock.adjust("10 minutes");
        // When
        yield* execInSandbox(keeper.id, ["true"]).pipe(
          Effect.provide(keeper.layers),
        );
        // Then
        expect(yield* keeper.deadline).toBe("1970-01-01T00:25:00.000Z");
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped("a command through the Keeper never pushes past Max life", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given
      const keeper = yield* warmKeeper(env, {
        maxLife: Duration.minutes(20),
      });
      yield* TestClock.adjust("10 minutes");
      // When
      yield* execInSandbox(keeper.id, ["true"]).pipe(
        Effect.provide(keeper.layers),
      );
      // Then
      expect(yield* keeper.deadline).toBe("1970-01-01T00:20:00.000Z");
    }).pipe(runtimeConfig(env));
  });

  it.scoped(
    "a Sandbox gone under a warm Keeper fails with the same message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const keeper = yield* warmKeeper(env);
        rmSync(join(env.root, keeper.name), { recursive: true, force: true });
        // When
        const error = yield* execInSandbox(keeper.id, ["true"]).pipe(
          Effect.provide(keeper.layers),
          Effect.flip,
        );
        // Then
        expect(error.message).toBe(`Sandbox ${keeper.id} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a Pixel helper through a warm Keeper asks the Provider nothing from the CLI",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a desktop Sandbox whose helper is `echo`
        const keeper = yield* warmKeeper(env, { desktop: true });
        yield* TestClock.adjust("10 minutes");
        // When
        const result = yield* runHelper(
          keeper.id,
          { feature: "desktop", paths: { linux: "echo" } },
          ["clicked"],
          { outcome: "click" },
        ).pipe(Effect.provide(keeper.layers));
        // Then
        expect(result.stdout.toString("utf8")).toBe("clicked\n");
        expect(keeper.calls).toEqual({ get: 0, extend: 0 });
        expect(yield* keeper.deadline).toBe("1970-01-01T00:25:00.000Z");
      }).pipe(runtimeConfig(env));
    },
  );
});

describe("Create marks", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  it.effect(
    "a create mark holds its process start time and counts as live",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        const path = yield* markCreate("fake");
        const [pid, started] = readFileSync(path, "utf8").split("\n");
        expect(pid).toBe(String(process.pid));
        expect(started).not.toBe("");
        expect(yield* liveCreates("fake")).toEqual([basename(path)]);
        yield* unmarkCreate(path);
        expect(yield* liveCreates("fake")).toEqual([]);
      }).pipe(runtimeConfig(env));
    },
  );

  it.effect(
    "a create mark with no start time counts while its process runs",
    () => {
      const env = makeEnv();
      const name = `fake-creating-${process.pid}-0123abcd`;
      writeFileSync(join(env.runtime, name), `${process.pid}\n\n`);
      return Effect.gen(function* () {
        expect(yield* liveCreates("fake")).toEqual([name]);
      }).pipe(runtimeConfig(env));
    },
  );
});
