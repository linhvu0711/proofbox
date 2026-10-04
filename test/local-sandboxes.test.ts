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
import { ConfigProvider, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeFakeProvider } from "../src/fake/fake-provider.ts";
import { liveCreates, withCreateMark } from "../src/local-sandboxes.ts";
import type { Provider } from "../src/provider.ts";
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

// A machine with a saved fake login: its HOME, its runtime dir, and the
// fake Provider.
const makeMachine = (
  options: { readonly envToken?: boolean; readonly noLogin?: boolean } = {},
) => {
  const home = tempDir("proofbox-home-");
  const runtime = tempDir("proofbox-runtime-");
  const root = tempDir("proofbox-fake-");
  mkdirSync(join(home, ".config", "proofbox"), { recursive: true });
  writeFileSync(
    join(home, ".config", "proofbox", "logins.json"),
    '{"fake":{"way":"token","token":"t0k"}}',
  );
  const fake = makeFakeProvider({ root, watch: "none" });
  const provider: Provider =
    options.noLogin === true ? { ...fake, login: { _tag: "None" } } : fake;
  const config = new Map([
    ["HOME", home],
    ["PROOFBOX_RUNTIME_DIR", runtime],
    ...(options.envToken === true
      ? [["PROOFBOX_FAKE_TOKEN", "t0k"] as const]
      : []),
  ]);
  return {
    home,
    runtime,
    provider,
    configured: Effect.withConfigProvider(ConfigProvider.fromMap(config)),
  };
};

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

  it.live(
    "a create mark with no start time counts while its process runs",
    () => {
      const machine = makeMachine();
      const name = `fake-creating-${process.pid}-0123abcd`;
      writeFileSync(join(machine.runtime, name), `${process.pid}\n\n`);
      return Effect.gen(function* () {
        expect(yield* liveCreates("fake")).toEqual([name]);
      }).pipe(machine.configured);
    },
  );

  // Where process 1 is this user's (root, or some containers), the case
  // cannot happen.
  it.live.skipIf(ownsPid1())(
    "a create mark whose process id belongs to another user is not live",
    () => {
      const machine = makeMachine();
      writeFileSync(join(machine.runtime, "fake-creating-1-0123abcd"), "1\n\n");
      return Effect.gen(function* () {
        expect(yield* liveCreates("fake")).toEqual([]);
      }).pipe(machine.configured);
    },
  );
});
