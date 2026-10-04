import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Chunk,
  ConfigProvider,
  Duration,
  Effect,
  Fiber,
  Ref,
  Stream,
  TestClock,
  TestServices,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import { ProviderError, ProviderUnavailableError } from "../src/errors.ts";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { runHelper } from "../src/helper.ts";
import { runKeeper } from "../src/keeper/keeper.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { keeperPaths } from "../src/keeper/paths.ts";
import { Progress } from "../src/progress.ts";
import {
  type ExecEvent,
  type Provider,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { sleepsNear } from "./support/clock.ts";
import { withCall } from "./support/connection.ts";
import {
  eventually,
  keeperClientLayers,
  startKeeper,
} from "./support/keeper.ts";
import { nodeFs } from "./support/node-fs.ts";

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

// The start lock a Keeper killed mid-start leaves: its owner is a pid
// that no longer runs.
const staleStartLock = (env: { runtime: string }, name: string) => {
  const dead = spawnSync("true").pid;
  const lock = join(env.runtime, `fake-${name}.start-lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${dead}\nkilled\n\n`);
};

const runtimeConfig = (env: { runtime: string }) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", env.runtime]])),
  );

// A fake Sandbox made at t=0, and a Provider that counts the `get` and
// `extend` calls made to it from the CLI side in `calls`, and the Keeper's
// own reads of the Sandbox over its Connection (the gone-watch) in
// `watched`.
const countedSandbox = (
  env: { root: string; runtime: string },
  options: {
    readonly maxLife?: Duration.Duration;
    readonly desktop?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fake = makeFakeProvider({
      fs: nodeFs,
      root: env.root,
      watch: "none",
    });
    const info = yield* fake
      .create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: options.maxLife ?? Duration.hours(3),
      })
      .pipe(Effect.provideService(Progress, noProgress));
    const calls = { get: 0, extend: 0 };
    const watched = { get: 0, extend: 0 };
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
      connect: (ref) =>
        Effect.map(fake.connect(ref), (connection) => ({
          ...connection,
          get: Effect.suspend(() => {
            watched.get += 1;
            return connection.get;
          }),
          extend: (deadline: Date) =>
            Effect.suspend(() => {
              watched.extend += 1;
              return connection.extend(deadline);
            }),
        })),
    };
    return {
      fake,
      id: `fake:${info.name}`,
      name: info.name,
      calls,
      watched,
      counted,
    };
  });

// A counted fake Sandbox with a Keeper run in this process, and the layers
// a command needs to reach it.
const warmKeeper = (
  env: { root: string; runtime: string },
  options: {
    readonly maxLife?: Duration.Duration;
    readonly desktop?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const sandbox = yield* countedSandbox(env, options);
    const layers = yield* startKeeper(sandbox.id, sandbox.counted);
    sandbox.calls.get = 0;
    sandbox.calls.extend = 0;
    return {
      id: sandbox.id,
      name: sandbox.name,
      calls: sandbox.calls,
      watched: sandbox.watched,
      layers,
    };
  });

// A counted fake Sandbox with no Keeper running, and the layers a command
// needs to reach it; `overrides` replace calls of the counted Provider.
const coldSandbox = (
  env: { root: string; runtime: string },
  overrides: Partial<Provider> = {},
) =>
  Effect.map(countedSandbox(env), (sandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    calls: sandbox.calls,
    layers: keeperClientLayers({ ...sandbox.counted, ...overrides }),
  }));

const capturedOut = Effect.gen(function* () {
  const output = yield* CliOutput;
  return Chunk.toReadonlyArray(yield* Ref.get(output.captured.out)).join("");
});

const capturedErr = Effect.gen(function* () {
  const output = yield* CliOutput;
  return Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join("");
});

// A Keeper socket for fake Sandbox `name` that drops each connection
// before it reads the request, as a Keeper does when its Sandbox is gone.
const droppingKeeper = (name: string) =>
  Effect.gen(function* () {
    const { socket } = yield* keeperPaths({ provider: "fake", name }).pipe(
      Effect.provide(NodeContext.layer),
    );
    yield* Effect.acquireRelease(
      Effect.async<Server>((resume) => {
        const server = createServer((client) => client.destroy());
        server.listen(socket, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.promise(
          () => new Promise<void>((done) => server.close(() => done())),
        ),
    );
  });

// A Keeper socket for fake Sandbox `name` that reads the request, counts it
// in `requests`, sends `reply` when given, and closes, as a Keeper can when
// it shuts down after it read the request.
const closingKeeper = (name: string, reply?: string) =>
  Effect.gen(function* () {
    const { socket } = yield* keeperPaths({ provider: "fake", name }).pipe(
      Effect.provide(NodeContext.layer),
    );
    const requests = { count: 0 };
    yield* Effect.acquireRelease(
      Effect.async<Server>((resume) => {
        const server = createServer((client) => {
          let pending = "";
          client.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            if (!pending.includes("\n")) {
              return;
            }
            requests.count += 1;
            if (reply === undefined) {
              client.destroy();
            } else {
              client.end(`${reply}\n`);
            }
          });
        });
        server.listen(socket, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.promise(
          () => new Promise<void>((done) => server.close(() => done())),
        ),
    );
    return { requests };
  });

// Runs `argv` through the Keeper client and gives its failure.
const keeperExecError = (id: string, argv: ReadonlyArray<string>) =>
  Effect.flatMap(KeeperClient, (client) => client.exec(id, argv)).pipe(
    Effect.flatMap(Stream.runDrain),
    Effect.flip,
  );

// Whether a process whose command line holds `pattern` runs on this machine.
const running = (pattern: string) =>
  Effect.sync(() => spawnSync("pgrep", ["-f", pattern]).status === 0);

// A sleep length no other run of these tests uses, so a command left over
// from an earlier run never counts.
const nap = `61.${process.pid}`;

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
    expect(replies).toEqual([{ exit: 0, kills: [0, 0] }]);
    const again = await runCli(env, ["exec", id, "--", "echo", "still"]);
    expect(again.stdout).toBe("still\n");
    expect(again.exitCode).toBe(0);
  });

  it("a request the Keeper cannot read gets a bad request answer", async () => {
    // Given
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    const socket = createConnection({
      path: join(env.runtime, `fake-${name}.sock`),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    // When: the first line is not a request
    socket.write("not json\n");
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
    // Then
    expect(replies).toEqual([{ fail: "bad request" }]);
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
    // fake does, so the Keeper never reads a half-written Deadline file.
    const deadlineFile = join(env.root, name, "deadline");
    writeFileSync(
      `${deadlineFile}.tmp`,
      `${Math.floor((Date.now() - 1000) / 1000)}\n`,
    );
    renameSync(`${deadlineFile}.tmp`, deadlineFile);
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
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
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

  it.effect(
    "the Keeper leaves no temp file when it cannot write its pid file",
    () =>
      Effect.gen(function* () {
        // Given: a Sandbox, and a folder where the Keeper's pid file goes
        const env = makeEnv();
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        mkdirSync(join(env.runtime, `fake-${info.name}.pid`));
        // When
        yield* runKeeper(`fake:${info.name}`).pipe(
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
        expect(
          readdirSync(env.runtime).filter((file) => file.endsWith(".tmp")),
        ).toEqual([]);
      }),
  );

  it.scopedLive(
    "a second Keeper started at once leaves the first one's socket and pid file",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a Sandbox
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        const keeper = runKeeper(`fake:${info.name}`).pipe(
          Effect.provideService(
            Providers,
            new Map([["fake", providerEntry(fake)]]),
          ),
          Effect.provide(NodeContext.layer),
        );
        // When: two Keepers start together, and the one that lost ends
        const first = yield* Effect.forkScoped(keeper);
        const second = yield* Effect.forkScoped(keeper);
        yield* Effect.race(Fiber.await(first), Fiber.await(second));
        // Then
        expect([
          existsSync(join(env.runtime, `fake-${info.name}.sock`)),
          existsSync(join(env.runtime, `fake-${info.name}.pid`)),
        ]).toEqual([true, true]);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scopedLive(
    "a Keeper takes over a start lock that a killed Keeper left",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a Sandbox, and the start lock of a Keeper killed mid-start
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        staleStartLock(env, info.name);
        const socket = join(env.runtime, `fake-${info.name}.sock`);
        // When
        yield* Effect.forkScoped(
          runKeeper(`fake:${info.name}`).pipe(
            Effect.provideService(
              Providers,
              new Map([["fake", providerEntry(fake)]]),
            ),
            Effect.provide(NodeContext.layer),
          ),
        );
        for (let i = 0; i < 100 && !existsSync(socket); i++) {
          yield* Effect.sleep("100 millis");
        }
        // Then
        expect(existsSync(socket)).toBe(true);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scopedLive(
    "two Keepers that take over one stale start lock leave one Keeper's socket and pid file",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a Sandbox, and the start lock of a Keeper killed mid-start
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        staleStartLock(env, info.name);
        const keeper = runKeeper(`fake:${info.name}`).pipe(
          Effect.provideService(
            Providers,
            new Map([["fake", providerEntry(fake)]]),
          ),
          Effect.provide(NodeContext.layer),
        );
        // When: two Keepers start together, and the one that lost ends
        const first = yield* Effect.forkScoped(keeper);
        const second = yield* Effect.forkScoped(keeper);
        yield* Effect.race(Fiber.await(first), Fiber.await(second));
        // Then
        expect([
          existsSync(join(env.runtime, `fake-${info.name}.sock`)),
          existsSync(join(env.runtime, `fake-${info.name}.pid`)),
        ]).toEqual([true, true]);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scopedLive(
    "a Keeper takes over a start lock whose pid another process now runs",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a Sandbox, and a start lock whose pid is this process,
        // which started at another time than the owner did
        const fake = makeFakeProvider({
          fs: nodeFs,
          root: env.root,
          watch: "none",
        });
        const info = yield* fake
          .create({
            os: "linux",
            idle: Duration.minutes(5),
            maxLife: Duration.hours(1),
          })
          .pipe(Effect.provideService(Progress, noProgress));
        const lock = join(env.runtime, `fake-${info.name}.start-lock`);
        mkdirSync(lock);
        writeFileSync(
          join(lock, "owner"),
          `${process.pid}\nreused\nThu Jan  1 00:00:00 1970\n`,
        );
        const socket = join(env.runtime, `fake-${info.name}.sock`);
        // When
        yield* Effect.forkScoped(
          runKeeper(`fake:${info.name}`).pipe(
            Effect.provideService(
              Providers,
              new Map([["fake", providerEntry(fake)]]),
            ),
            Effect.provide(NodeContext.layer),
          ),
        );
        for (let i = 0; i < 20 && !existsSync(socket); i++) {
          yield* Effect.sleep("100 millis");
        }
        // Then
        expect(existsSync(socket)).toBe(true);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scopedLive("a Keeper never takes over a live start lock", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: a Sandbox, and the start lock of a Keeper that still runs
      const fake = makeFakeProvider({
        fs: nodeFs,
        root: env.root,
        watch: "none",
      });
      const info = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const lock = join(env.runtime, `fake-${info.name}.start-lock`);
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), `${process.pid}\nlive\n\n`);
      // When
      yield* runKeeper(`fake:${info.name}`).pipe(
        Effect.provideService(
          Providers,
          new Map([["fake", providerEntry(fake)]]),
        ),
        Effect.provide(NodeContext.layer),
        Effect.flip,
      );
      // Then
      expect(readFileSync(join(lock, "owner"), "utf8")).toBe(
        `${process.pid}\nlive\n\n`,
      );
    }).pipe(runtimeConfig(env));
  });

  it.scoped("the pid file names the Keeper once its socket exists", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: a Sandbox and its Keeper starting in this process
      const fake = makeFakeProvider({
        fs: nodeFs,
        root: env.root,
        watch: "none",
      });
      const info = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(5),
          maxLife: Duration.hours(1),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const socket = join(env.runtime, `fake-${info.name}.sock`);
      yield* Effect.forkScoped(
        runKeeper(`fake:${info.name}`).pipe(
          Effect.provideService(
            Providers,
            new Map([["fake", providerEntry(fake)]]),
          ),
          Effect.provide(NodeContext.layer),
        ),
      );
      // When: the socket shows up, the pid file is read at once
      let pid: number | undefined;
      for (let i = 0; i < 5000 && pid === undefined; i++) {
        pid = yield* Effect.sync(() =>
          existsSync(socket) ? keeperPid(env, info.name) : undefined,
        );
        yield* TestServices.provideLive(Effect.sleep("1 millis"));
      }
      // Then
      expect(alive(pid ?? Number.NaN)).toBe(true);
    }).pipe(runtimeConfig(env));
  });

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
    "a command through a warm Keeper gives back its memory-kill counts unchanged",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a Sandbox that has seen 2 memory kills
        const sandbox = yield* countedSandbox(env);
        writeFileSync(join(env.root, sandbox.name, "memory-kills"), "2\n");
        const layers = yield* startKeeper(sandbox.id, sandbox.counted);
        // When: 3 more happen while the command runs
        const events = yield* Effect.flatMap(KeeperClient, (client) =>
          Effect.flatMap(
            client.exec(sandbox.id, ["sh", "-c", "echo 5 > ../memory-kills"]),
            (stream) => Stream.runCollect(stream),
          ),
        ).pipe(Effect.provide(layers));
        // Then
        expect(Chunk.toReadonlyArray(events).at(-1)).toEqual({
          _tag: "Exit",
          code: 0,
          kills: { before: 2, after: 5 },
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it("a command through the Keeper never pushes the Deadline past Max life", async () => {
    // Given: a Sandbox whose Max life comes before its idle time
    const env = makeEnv();
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--idle",
      "15m",
      "--max-life",
      "5m",
    ]);
    const name = created.stdout.trim().slice("fake:".length);
    // When
    const result = await runCli(env, ["exec", `fake:${name}`, "--", "true"]);
    // Then: the pushed Deadline is Max life, within the Sandbox clock's
    // whole second
    const dir = join(env.root, name);
    const maxLife = Math.floor(
      new Date(
        JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8")).maxLifeAt,
      ).getTime() / 1000,
    );
    const deadline = Number(readFileSync(join(dir, "deadline"), "utf8"));
    expect({
      exitCode: result.exitCode,
      atMaxLife: deadline <= maxLife && deadline >= maxLife - 2,
    }).toEqual({ exitCode: 0, atMaxLife: true });
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
    "the gone-watch first reads the Sandbox one interval after the Keeper serves",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const keeper = yield* warmKeeper(env);
        yield* TestServices.provideLive(Effect.sleep("200 millis"));
        const before = keeper.watched.get;
        // When
        yield* TestClock.adjust("2 seconds");
        yield* eventually(Effect.sync(() => keeper.watched.get >= 1));
        // Then
        expect([before, keeper.watched.get]).toEqual([0, 1]);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command with no Keeper on a gone Sandbox fails at once with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const [error, err] = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.zip(capturedErr),
          Effect.provide(sandbox.layers),
        );
        // Then
        expect({ message: error.message, err }).toEqual({
          message: `Sandbox fake:${sandbox.name} is gone`,
          err: "",
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info with no Keeper on a gone Sandbox fails with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const error = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.flip, Effect.provide(sandbox.layers));
        // Then
        expect(error.message).toBe(`Sandbox fake:${sandbox.name} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command with no Keeper fails with the Provider's message when the Provider cannot be reached",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env, {
          get: () =>
            Effect.fail(
              new ProviderUnavailableError({
                provider: "fake",
                reason: "fake Provider did not answer",
              }),
            ),
        });
        // When
        const [error, err] = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.zip(capturedErr),
          Effect.provide(sandbox.layers),
        );
        // Then
        expect({ message: error.message, err }).toEqual({
          message: "fake Provider did not answer",
          err: "",
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command with no Keeper on an unfinished Sandbox fails with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        rmSync(join(env.root, sandbox.name, "sandbox.json"));
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect(error.message).toBe(`Sandbox fake:${sandbox.name} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through a Keeper that drops it on a gone Sandbox fails with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* droppingKeeper(sandbox.name);
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect(error.message).toBe(`Sandbox fake:${sandbox.name} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info through a Keeper that drops the request reads the Provider",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* droppingKeeper(sandbox.name);
        // When
        const info = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.provide(sandbox.layers));
        // Then
        expect({ name: info.name, get: sandbox.calls.get }).toEqual({
          name: sandbox.name,
          get: 1,
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through a Keeper that closes after it reads the request on a gone Sandbox fails with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name);
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect(error.message).toBe(`Sandbox fake:${sandbox.name} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through a Keeper that closes after it reads the request keeps its error and is not sent again",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: the Sandbox stays
        const sandbox = yield* coldSandbox(env);
        const { requests } = yield* closingKeeper(sandbox.name);
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect({
          message: error.message,
          requests: requests.count,
          get: sandbox.calls.get,
        }).toEqual({
          message:
            "Provider fake failed: Keeper closed the connection before the command exited",
          requests: 1,
          get: 1,
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through a Keeper that closes after it reads the request keeps its error when the Provider cannot be reached",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env, {
          get: () =>
            Effect.fail(
              new ProviderUnavailableError({
                provider: "fake",
                reason: "fake Provider did not answer",
              }),
            ),
        });
        yield* closingKeeper(sandbox.name);
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect(error.message).toBe(
          "Provider fake failed: Keeper closed the connection before the command exited",
        );
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a fail frame from the Keeper shows as it is, with no Provider check",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name, '{"fail":"fake Keeper failed"}');
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect({ message: error.message, get: sandbox.calls.get }).toEqual({
          message: "Provider fake failed: fake Keeper failed",
          get: 0,
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a command through a Keeper that sends a line that does not decode fails with the decode error",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name, "not json");
        // When
        const error = yield* keeperExecError(sandbox.id, ["true"]).pipe(
          Effect.provide(sandbox.layers),
        );
        // Then
        expect({ message: error.message, get: sandbox.calls.get }).toEqual({
          message: `Provider fake failed: Unexpected token 'o', "not json" is not valid JSON`,
          get: 0,
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info through a Keeper that closes after it reads the request on a gone Sandbox fails with the gone message",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name);
        rmSync(join(env.root, sandbox.name), { recursive: true, force: true });
        // When
        const error = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.flip, Effect.provide(sandbox.layers));
        // Then
        expect(error.message).toBe(`Sandbox fake:${sandbox.name} is gone`);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info through a Keeper that closes after it reads the request reads the Provider",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: the Sandbox stays
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name);
        // When
        const info = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.provide(sandbox.layers));
        // Then
        expect({ name: info.name, get: sandbox.calls.get }).toEqual({
          name: sandbox.name,
          get: 1,
        });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info through a Keeper that closes after it reads the request keeps its error when the Provider cannot be reached",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env, {
          get: () =>
            Effect.fail(
              new ProviderUnavailableError({
                provider: "fake",
                reason: "fake Provider did not answer",
              }),
            ),
        });
        yield* closingKeeper(sandbox.name);
        // When
        const error = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.flip, Effect.provide(sandbox.layers));
        // Then
        expect(error.message).toBe(
          "Provider fake failed: Keeper closed the connection before it answered",
        );
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "Sandbox info through a Keeper that sends a line that does not decode fails with the decode error",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given
        const sandbox = yield* coldSandbox(env);
        yield* closingKeeper(sandbox.name, "not json");
        // When
        const error = yield* Effect.flatMap(KeeperClient, (client) =>
          client.info(sandbox.id),
        ).pipe(Effect.flip, Effect.provide(sandbox.layers));
        // Then
        expect(error.message).toBe(
          `Provider fake failed: Unexpected token 'o', "not json" is not valid JSON`,
        );
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "stop leaves a process that is not a Keeper alone and removes the Keeper files",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a pid file that names a process other than a Keeper
        const sandbox = yield* coldSandbox(env);
        const child = spawn("sleep", ["30"]);
        yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()));
        const pid = yield* Effect.orDie(Effect.fromNullable(child.pid));
        const pidFile = join(env.runtime, `fake-${sandbox.name}.pid`);
        const socketFile = join(env.runtime, `fake-${sandbox.name}.sock`);
        writeFileSync(pidFile, `${pid}\n`);
        writeFileSync(socketFile, "");
        // When
        yield* Effect.flatMap(KeeperClient, (client) =>
          client.stop(sandbox.id),
        ).pipe(Effect.provide(sandbox.layers));
        // Then
        expect({
          alive: alive(pid),
          pid: existsSync(pidFile),
          socket: existsSync(socketFile),
        }).toEqual({ alive: true, pid: false, socket: false });
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
          {
            outcome: "click",
            limit: { _tag: "Act", name: "click", extra: Duration.zero },
          },
        ).pipe(Effect.provide(keeper.layers));
        // Then
        expect(result.stdout.toString("utf8")).toBe("clicked\n");
        expect(keeper.calls).toEqual({ get: 0, extend: 0 });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped(
    "a Caller who leaves ends the command and its Deadline push",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a command that runs for a minute through a warm Keeper
        const keeper = yield* warmKeeper(env);
        yield* TestClock.adjust("10 minutes");
        const caller = yield* Effect.fork(
          Effect.scoped(
            Effect.flatMap(KeeperClient, (client) =>
              Effect.flatMap(client.exec(keeper.id, ["sleep", nap]), (events) =>
                Stream.runDrain(events),
              ),
            ),
          ).pipe(Effect.provide(keeper.layers)),
        );
        yield* eventually(running(`sleep ${nap}`));
        // When: the Caller leaves, as Ctrl-C does
        yield* Fiber.interrupt(caller);
        yield* eventually(Effect.map(running(`sleep ${nap}`), (on) => !on));
        yield* TestClock.adjust("14 minutes");
        // Then
        expect({
          extends: keeper.watched.extend,
          running: yield* running(`sleep ${nap}`),
        }).toEqual({ extends: 0, running: false });
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped("a Caller who gives up ends the command in the Keeper", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: a helper call that runs for a minute through a warm Keeper
      const keeper = yield* warmKeeper(env, { desktop: true });
      yield* TestClock.adjust("10 minutes");
      const caller = yield* Effect.fork(
        runHelper(
          keeper.id,
          { feature: "desktop", paths: { linux: "sleep" } },
          [nap],
          {
            outcome: "click",
            limit: { _tag: "Act", name: "click", extra: Duration.zero },
          },
        ).pipe(Effect.provide(keeper.layers), Effect.flip),
      );
      yield* eventually(running(`sleep ${nap}`));
      yield* sleepsNear(720_000);
      // When: its time limit passes
      yield* TestClock.adjust("121 seconds");
      yield* Fiber.join(caller);
      yield* eventually(Effect.map(running(`sleep ${nap}`), (on) => !on));
      // Then
      expect(yield* running(`sleep ${nap}`)).toBe(false);
    }).pipe(runtimeConfig(env));
  });
  it.scoped(
    "a Caller who gives up after its input ends is logged as gave up",
    () => {
      const env = makeEnv();
      return Effect.gen(function* () {
        // Given: a helper call whose input is sent whole, then runs a minute
        const keeper = yield* warmKeeper(env, { desktop: true });
        yield* TestClock.adjust("10 minutes");
        const caller = yield* Effect.fork(
          runHelper(
            keeper.id,
            { feature: "desktop", paths: { linux: "sleep" } },
            [nap],
            {
              outcome: "build",
              stdin: Stream.make(new TextEncoder().encode("script\n")),
              limit: { _tag: "Act", name: "build", extra: Duration.zero },
            },
          ).pipe(Effect.provide(keeper.layers), Effect.flip),
        );
        yield* eventually(running(`sleep ${nap}`));
        yield* sleepsNear(720_000);
        // When: its time limit passes
        yield* TestClock.adjust("121 seconds");
        yield* Fiber.join(caller);
        const log = join(env.runtime, `fake-${keeper.name}.log`);
        yield* eventually(
          Effect.sync(
            () =>
              existsSync(log) &&
              readFileSync(log, "utf8").includes("exec sleep"),
          ),
        );
        // Then
        expect(readFileSync(log, "utf8")).toMatch(/ exec sleep .* gave up\n$/);
      }).pipe(runtimeConfig(env));
    },
  );

  it.scoped("a failed command logs its error kind, not its text", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: a Provider whose exec fails with the command line in its text
      const fake = makeFakeProvider({
        fs: nodeFs,
        root: env.root,
        watch: "none",
      });
      const info = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const failing: Provider = {
        ...fake,
        connect: (ref) =>
          Effect.map(fake.connect(ref), (connection) =>
            withCall(connection, () =>
              Stream.fail(
                new ProviderError({
                  provider: "fake",
                  reason: "spawn ENOENT (docker exec sh -c echo tok-2718)",
                }),
              ),
            ),
          ),
      };
      const id = `fake:${info.name}`;
      const layers = yield* startKeeper(id, failing);
      // When
      yield* execInSandbox(id, ["echo", "tok-2718"]).pipe(
        Effect.provide(layers),
        Effect.ignore,
      );
      // Then
      const log = readFileSync(
        join(env.runtime, `fake-${info.name}.log`),
        "utf8",
      );
      expect({
        ended: log.trimEnd().split(" ").slice(-2).join(" "),
        secret: log.includes("tok-2718"),
      }).toEqual({ ended: "error: ProviderError", secret: false });
    }).pipe(runtimeConfig(env));
  });

  it.scoped("the Keeper writes one log line per request", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given
      const keeper = yield* warmKeeper(env);
      yield* TestClock.adjust("10 minutes");
      // When
      yield* execInSandbox(keeper.id, ["echo", "hi"]).pipe(
        Effect.provide(keeper.layers),
      );
      // Then
      expect(
        readFileSync(join(env.runtime, `fake-${keeper.name}.log`), "utf8"),
      ).toBe(
        "1970-01-01T00:10:00Z info - out=0 err=0 exit=- first=- took=0.0s done\n1970-01-01T00:10:00Z exec sh out=3 err=0 exit=0 first=0.0s took=0.0s done\n",
      );
    }).pipe(runtimeConfig(env));
  });

  // The Keeper log of one exec whose events the Provider scripts;
  // "pause" stands for 5 s of the command running.
  const scriptedExecLog = (
    env: ReturnType<typeof makeEnv>,
    events: ReadonlyArray<ExecEvent | "pause">,
  ) =>
    Effect.gen(function* () {
      const fake = makeFakeProvider({
        fs: nodeFs,
        root: env.root,
        watch: "none",
      });
      const info = yield* fake
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        })
        .pipe(Effect.provideService(Progress, noProgress));
      const scripted: Provider = {
        ...fake,
        connect: (ref) =>
          Effect.map(fake.connect(ref), (connection) =>
            withCall(connection, () =>
              Stream.fromIterable(events).pipe(
                Stream.flatMap((event) =>
                  event === "pause"
                    ? Stream.drain(Stream.fromEffect(Effect.sleep("5 seconds")))
                    : Stream.make(event),
                ),
              ),
            ),
          ),
      };
      const id = `fake:${info.name}`;
      const layers = yield* startKeeper(id, scripted);
      const caller = yield* Effect.fork(
        execInSandbox(id, ["sh"]).pipe(Effect.provide(layers)),
      );
      yield* sleepsNear(5_000);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(caller);
      return readFileSync(join(env.runtime, `fake-${info.name}.log`), "utf8");
    });

  const hi: ExecEvent = {
    _tag: "Stdout",
    bytes: new TextEncoder().encode("hi\n"),
  };
  const exit: ExecEvent = { _tag: "Exit", code: 0 };

  it.scoped("the Keeper logs when the first output byte came", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: a command that writes at once, then runs 5 s more
      const events = [hi, "pause", exit] as const;
      // When
      const log = yield* scriptedExecLog(env, events);
      // Then
      expect(log).toContain(
        " exec sh out=3 err=0 exit=0 first=0.0s took=5.0s done\n",
      );
    }).pipe(runtimeConfig(env));
  });

  it.scoped("an empty output chunk is not the first byte", () => {
    const env = makeEnv();
    return Effect.gen(function* () {
      // Given: an empty chunk at once, the first byte 5 s later
      const empty: ExecEvent = { _tag: "Stdout", bytes: new Uint8Array(0) };
      const events = [empty, "pause", hi, exit] as const;
      // When
      const log = yield* scriptedExecLog(env, events);
      // Then
      expect(log).toContain(
        " exec sh out=3 err=0 exit=0 first=5.0s took=5.0s done\n",
      );
    }).pipe(runtimeConfig(env));
  });

  it("the Keeper log never holds exec arguments", async () => {
    // Given
    const env = makeEnv();
    const id = (
      await runCli(env, ["create", "--os", "linux", "--provider", "fake"])
    ).stdout.trim();
    const name = id.slice("fake:".length);
    // When
    await runCli(env, ["exec", id, "--", "echo", "tok-3141"]);
    // Then
    const log = readFileSync(join(env.runtime, `fake-${name}.log`), "utf8");
    expect(log.includes("tok-3141")).toBe(false);
  });

  it("the Keeper log stays after delete", async () => {
    // Given
    const env = makeEnv();
    const id = (
      await runCli(env, ["create", "--os", "linux", "--provider", "fake"])
    ).stdout.trim();
    const name = id.slice("fake:".length);
    await runCli(env, ["exec", id, "--", "true"]);
    // When
    await runCli(env, ["delete", id]);
    // Then
    expect(existsSync(join(env.runtime, `fake-${name}.log`))).toBe(true);
  });

  it("exec still works when the Keeper log cannot be written", async () => {
    // Given: a folder where the log file goes
    const env = makeEnv();
    const id = (
      await runCli(env, ["create", "--os", "linux", "--provider", "fake"])
    ).stdout.trim();
    const name = id.slice("fake:".length);
    mkdirSync(join(env.runtime, `fake-${name}.log`));
    // When
    const result = await runCli(env, ["exec", id, "--", "echo", "hi"]);
    // Then
    expect({ stdout: result.stdout, exitCode: result.exitCode }).toEqual({
      stdout: "hi\n",
      exitCode: 0,
    });
  });
});
