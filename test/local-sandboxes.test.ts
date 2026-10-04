import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Ref,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { logOut, withCreateMark } from "../src/local-sandboxes.ts";
import { readLogins } from "../src/login/logins-file.ts";
import { type Provider, Providers, providerEntry } from "../src/provider.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";

afterEach(() => {
  cleanupEnvs();
});

const tempDir = (prefix: string) => {
  // macOS's per-user tmpdir is long; the runtime dir stays short, as in
  // `test/support/cli.ts`.
  const dir = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix),
  );
  trackTempDir(dir);
  return dir;
};

const saveFakeLogin = (home: string) =>
  writeFileSync(
    join(home, ".config", "proofbox", "logins.json"),
    '{"fake":{"way":"token","token":"t0k"}}',
  );

// A machine with a saved fake login: its HOME, its runtime dir, and the
// fake Provider.
const makeMachine = (
  options: {
    readonly envToken?: boolean;
    readonly noLogin?: boolean;
    readonly loginFiles?: Provider["loginFiles"];
    // The runtime dir is a regular file, so nothing in it can be read.
    readonly runtimeIsFile?: boolean;
  } = {},
) => {
  const home = tempDir("proofbox-home-");
  const runtime =
    options.runtimeIsFile === true
      ? join(tempDir("proofbox-file-"), "f")
      : tempDir("proofbox-runtime-");
  if (options.runtimeIsFile === true) {
    writeFileSync(runtime, "x");
  }
  const root = tempDir("proofbox-fake-");
  mkdirSync(join(home, ".config", "proofbox"), { recursive: true });
  saveFakeLogin(home);
  const fake = makeFakeProvider({ root, watch: "none" });
  const provider: Provider = {
    ...fake,
    ...(options.noLogin === true ? { login: { _tag: "None" } } : {}),
    ...(options.loginFiles === undefined
      ? {}
      : { loginFiles: options.loginFiles }),
  };
  const config = new Map([
    ["HOME", home],
    ["PROOFBOX_RUNTIME_DIR", runtime],
    ...(options.envToken === true
      ? [["PROOFBOX_FAKE_TOKEN", "t0k"] as const]
      : []),
  ]);
  const providers = Layer.succeed(
    Providers,
    new Map([["fake", providerEntry(provider)]]),
  );
  return {
    home,
    runtime,
    provider,
    // The Keeper stop is a border: the direct client stops nothing.
    configured: <A, E>(effect: Effect.Effect<A, E, KeeperClient>) =>
      effect.pipe(
        Effect.provide(KeeperClient.Direct.pipe(Layer.provide(providers))),
        Effect.withConfigProvider(ConfigProvider.fromMap(config)),
      ),
  };
};

const savedLogins = (home: string): unknown =>
  JSON.parse(
    readFileSync(join(home, ".config", "proofbox", "logins.json"), "utf8"),
  );

// Each create mark in the runtime dir, as its lines.
const marks = (runtime: string) =>
  readdirSync(runtime)
    .filter((name) => name.startsWith("fake-creating-"))
    .map((name) => readFileSync(join(runtime, name), "utf8").split("\n"));

const ownsPid1 = () => {
  try {
    process.kill(1, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Create marks", () => {
  it.live(
    "a create mark holds its process id and start time while the create runs, and goes when it ends",
    () => {
      // Given
      const machine = makeMachine();
      return Effect.gen(function* () {
        // When
        const during = yield* withCreateMark(
          machine.provider,
          Effect.sync(() => marks(machine.runtime)),
        );
        // Then
        expect(during).toHaveLength(1);
        expect(during[0]?.[0]).toBe(String(process.pid));
        expect(during[0]?.[1]).not.toBe("");
        expect(marks(machine.runtime)).toEqual([]);
      }).pipe(machine.configured);
    },
  );

  it.live("a create with the env token set leaves no mark", () => {
    // Given
    const machine = makeMachine({ envToken: true });
    return Effect.gen(function* () {
      // When
      const during = yield* withCreateMark(
        machine.provider,
        Effect.sync(() => marks(machine.runtime)),
      );
      // Then
      expect(during).toEqual([]);
    }).pipe(machine.configured);
  });

  it.live("a create on a Provider with no login leaves no mark", () => {
    // Given
    const machine = makeMachine({ noLogin: true });
    return Effect.gen(function* () {
      // When
      const during = yield* withCreateMark(
        machine.provider,
        Effect.sync(() => marks(machine.runtime)),
      );
      // Then
      expect(during).toEqual([]);
    }).pipe(machine.configured);
  });
});

describe("Logout and creates", () => {
  it.live(
    "a create marked before logout's last look holds logout until it ends",
    () => {
      // Given
      const machine = makeMachine();
      return Effect.gen(function* () {
        const marked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<number>();
        // When
        const create = yield* Effect.fork(
          withCreateMark(
            machine.provider,
            Deferred.succeed(marked, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.zipRight(readLogins),
            ),
          ),
        );
        yield* Deferred.await(marked);
        const logout = yield* Effect.fork(
          logOut(machine.provider, (creates) =>
            Deferred.succeed(waiting, creates),
          ),
        );
        const waited = yield* Deferred.await(waiting);
        yield* Deferred.succeed(release, undefined);
        const seen = yield* Fiber.join(create);
        const result = yield* Fiber.join(logout);
        // Then
        expect(waited).toBe(1);
        expect(Object.keys(seen)).toEqual(["fake"]);
        expect(result).toEqual({
          _tag: "LoggedOut",
          deleted: [],
          elsewhere: [],
          unfinishedElsewhere: [],
          failures: [],
        });
        expect(savedLogins(machine.home)).toEqual({});
      }).pipe(machine.configured);
    },
  );

  it.live(
    "a create that starts after logout removed the login finds no login",
    () => {
      // Given
      const machine = makeMachine();
      return Effect.gen(function* () {
        // When
        const result = yield* logOut(machine.provider, () => Effect.void);
        const seen = yield* withCreateMark(machine.provider, readLogins);
        // Then
        expect(result._tag).toBe("LoggedOut");
        expect(seen).toEqual({});
        expect(marks(machine.runtime)).toEqual([]);
      }).pipe(machine.configured);
    },
  );

  it.live(
    "creates that start while logout runs either hold it or find no login",
    () => {
      // Given
      const machine = makeMachine();
      return Effect.gen(function* () {
        for (let round = 0; round < 8; round++) {
          saveFakeLogin(machine.home);
          // When: a create's login reads, 20 ms apart, while it is marked
          const create = (i: number) =>
            Effect.sleep(Duration.millis((round * 7 + i * 5) % 40)).pipe(
              Effect.zipRight(
                withCreateMark(
                  machine.provider,
                  Effect.gen(function* () {
                    const first = Object.keys(yield* readLogins);
                    yield* Effect.sleep(Duration.millis(20));
                    const second = Object.keys(yield* readLogins);
                    return { first, second };
                  }),
                ),
              ),
            );
          const [, reads] = yield* Effect.all(
            [
              logOut(machine.provider, () => Effect.void),
              Effect.all([create(0), create(1), create(2)], {
                concurrency: "unbounded",
              }),
            ],
            { concurrency: "unbounded" },
          );
          // Then: no create saw its login go while it was marked
          expect(
            reads.filter(
              (read) =>
                read.first.includes("fake") && !read.second.includes("fake"),
            ),
          ).toEqual([]);
          expect(savedLogins(machine.home)).toEqual({});
        }
      }).pipe(machine.configured);
    },
    30_000,
  );

  it.live(
    "a create mark with no start time holds logout while its process runs",
    () => {
      // Given
      const machine = makeMachine();
      writeFileSync(
        join(machine.runtime, `fake-creating-${process.pid}-0123abcd`),
        `${process.pid}\n\n`,
      );
      return Effect.gen(function* () {
        const waiting = yield* Deferred.make<number>();
        // When
        const logout = yield* Effect.fork(
          logOut(machine.provider, (creates) =>
            Deferred.succeed(waiting, creates),
          ),
        );
        const waited = yield* Deferred.await(waiting);
        yield* Fiber.interrupt(logout);
        // Then
        expect(waited).toBe(1);
        expect(Object.keys(savedLogins(machine.home) as object)).toEqual([
          "fake",
        ]);
      }).pipe(machine.configured);
    },
  );

  // Where process 1 is this user's (root, or some containers), the case
  // cannot happen.
  it.live.skipIf(ownsPid1())(
    "a create mark whose process id belongs to another user does not hold logout",
    () => {
      // Given
      const machine = makeMachine();
      writeFileSync(join(machine.runtime, "fake-creating-1-0123abcd"), "1\n\n");
      return Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        // When
        const result = yield* logOut(machine.provider, () =>
          Ref.update(calls, (n) => n + 1),
        );
        // Then
        expect(result._tag).toBe("LoggedOut");
        expect(yield* Ref.get(calls)).toBe(0);
      }).pipe(machine.configured);
    },
  );
});

describe("Login files", () => {
  const fakeTokens = {
    what: "the cached fake tokens",
    names: /^fake-token-[0-9]+\.json$/,
  };

  it.live(
    "logout removes the files the Provider names as login files and keeps the rest",
    () => {
      // Given
      const machine = makeMachine({ loginFiles: [fakeTokens] });
      for (const name of [
        "fake-token-1.json",
        "fake-token-2.json",
        "fake-keep.json",
      ]) {
        writeFileSync(join(machine.runtime, name), "{}");
      }
      return Effect.gen(function* () {
        // When
        const result = yield* logOut(machine.provider, () => Effect.void);
        // Then
        expect(result).toMatchObject({ _tag: "LoggedOut", failures: [] });
        expect(readdirSync(machine.runtime).sort()).toEqual(["fake-keep.json"]);
      }).pipe(machine.configured);
    },
  );

  it.live(
    "logout names the login files it could not remove and still removes the login",
    () => {
      // Given
      const machine = makeMachine({
        loginFiles: [fakeTokens],
        runtimeIsFile: true,
      });
      return Effect.gen(function* () {
        // When
        const result = yield* logOut(machine.provider, () => Effect.void);
        // Then
        const failures = result._tag === "LoggedOut" ? result.failures : [];
        expect(failures.map((failure) => failure._tag)).toEqual([
          "ScanFailed",
          "LoginFilesKept",
        ]);
        expect(failures[1]).toMatchObject({ what: "the cached fake tokens" });
        expect(savedLogins(machine.home)).toEqual({});
      }).pipe(machine.configured);
    },
  );
});
