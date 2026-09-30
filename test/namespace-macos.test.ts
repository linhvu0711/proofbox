import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Stream,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { countMemoryKills } from "../src/namespace/mac-host.ts";
import type {
  CreateReq,
  NamespaceApi,
} from "../src/namespace/namespace-api.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type { NscClient } from "../src/namespace/nsc-client.ts";
import type {
  HostResult,
  Link,
  SshForward,
} from "../src/namespace/ssh-link.ts";
import { Progress } from "../src/progress.ts";
import type { ExecEvent } from "../src/provider.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";

type CreateRequest = CreateReq;

interface Answer {
  readonly exitCode?: number;
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string;
}

// A Namespace Mac behind fakes: the Compute API records its calls, the
// Link records each command line it runs and answers it from `answer`
// (exit 0 by default).
const makeMac = (
  answer: (line: string) => Answer | undefined = () => undefined,
  // Runs as the Link runs a line, e.g. to let a step take time.
  during: (line: string) => Effect.Effect<void> = () => Effect.void,
  // The ssh forward a Mac Live view asks for; `calls` still notes it.
  portForward: SshForward = () => Effect.die("unused"),
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const requests = yield* Ref.make<ReadonlyArray<CreateRequest>>([]);
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const detached = yield* Ref.make<
      ReadonlyArray<readonly [string, ReadonlyArray<string>]>
    >([]);
    const note = (all: Ref.Ref<ReadonlyArray<string>>, line: string) =>
      Ref.update(all, (list) => [...list, line]);
    const api: NamespaceApi = {
      create: (region, req) =>
        Ref.update(requests, (all) => [...all, req]).pipe(
          Effect.zipRight(note(calls, `create ${region}`)),
          Effect.as("abc123def4567"),
        ),
      wait: (region, instanceId) => note(calls, `wait ${region} ${instanceId}`),
      destroy: (region, instanceId) =>
        note(calls, `destroy ${region} ${instanceId}`),
      extend: (region, instanceId) =>
        note(calls, `extend ${region} ${instanceId}`),
      list: (region) => note(calls, `list ${region}`).pipe(Effect.as([])),
      sshConfig: () => Effect.die("unused"),
      checkToken: () => Effect.die("unused"),
    };
    const nsc: NscClient = {
      ensureImageExpiry: () => Effect.void,
    };
    const reply = (line: string) => {
      const found = answer(line) ?? defaultAnswer(line) ?? {};
      const stdout = found.stdout ?? "";
      return {
        exitCode: found.exitCode ?? 0,
        stdout,
        stderr: found.stderr ?? "",
      };
    };
    const link: Link = {
      ssh: [],
      run: (line) =>
        note(commands, line).pipe(
          Effect.zipRight(during(line)),
          Effect.map((): HostResult => {
            const { exitCode, stdout, stderr } = reply(line);
            return {
              exitCode,
              stdout:
                typeof stdout === "string"
                  ? stdout
                  : Buffer.from(stdout).toString("utf8"),
              stderr,
            };
          }),
        ),
      stream: (line) =>
        Stream.fromEffect(note(commands, line)).pipe(
          Stream.flatMap(() => {
            const { exitCode, stdout } = reply(line);
            const bytes =
              typeof stdout === "string"
                ? new TextEncoder().encode(stdout)
                : stdout;
            const events: ExecEvent[] = [
              ...(bytes.length === 0
                ? []
                : [{ _tag: "Stdout" as const, bytes }]),
              { _tag: "Exit", code: exitCode },
            ];
            return Stream.fromIterable(events);
          }),
        ),
    };
    const provider = makeNamespaceProvider({
      api,
      login: Effect.succeed({
        token: Redacted.make("token"),
        region: Option.none(),
      }),
      nsc,
      openLink: () => Effect.succeed(link),
      forward: (id, port) =>
        note(calls, `portForward ${id} ${port}`).pipe(
          Effect.zipRight(portForward(id, port)),
        ),
      dockerFor: () => {
        throw new Error("a Mac has no Docker");
      },
      spawnDetached: (_provider, rel, args) =>
        Ref.update(detached, (all) => [...all, [rel, args] as const]),
    });
    return { provider, calls, requests, commands, detached };
  });

// The Mac's own answer to `shasum -a 256 <paths>`: the pinned hashes.
const pinnedShasum = (line: string) =>
  line
    .slice("shasum -a 256 ".length)
    .split(" ")
    .map((path) => {
      const file = TOOL_BUNDLE.find((tool) => `'${tool.path}'` === path);
      return `${file?.macos?.arm64.sha256 ?? ""}  ${path.replaceAll("'", "")}\n`;
    })
    .join("");

// replayd keeps the far-future hint date proofbox wrote when no alert
// showed; when it shows one it moves the date to 30 days out.
const replaydKept = { stdout: "4000-01-01T00:00:00Z\n" };

const defaultAnswer = (line: string): Answer | undefined =>
  line.startsWith("shasum -a 256 ")
    ? { stdout: pinnedShasum(line) }
    : line.startsWith("plutil -extract")
      ? replaydKept
      : undefined;

// Three jetsam lines as the kernel logs them: one idle-daemon kill, then
// two kills of real work.
const JETSAM_LINES = [
  "2026-09-28 16:10:17.591 Df kernel[0:1cd] [com.apple.xnu:memorystatus] memorystatus: killing_idle_process pid 386 [wallpaperexportd] jetsam_reason->osr_code: 9",
  "2026-09-28 16:12:02.114 Df kernel[0:1cd] [com.apple.xnu:memorystatus] memorystatus: killing_top_process pid 901 [node] jetsam_reason->osr_code: 2",
  "2026-09-28 16:12:09.020 Df kernel[0:1cd] [com.apple.xnu:memorystatus] memorystatus: killing_specific_process pid 915 [swift-build] (per-process-limit 14)",
].join("\n");

const runtimeDir = () => mkdtempSync(join(tmpdir(), "proofbox-runtime-"));

const withRuntime =
  (runtime: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(
        Layer.mergeAll(
          CliOutput.Test,
          Layer.succeed(
            Progress,
            new Progress({
              step: (_label, effect) => effect,
              warn: () => Effect.void,
            }),
          ),
        ),
      ),
    );

const createMac = (size?: { cpu: number; ramGb: number }) => ({
  os: "macos" as const,
  idle: Duration.minutes(5),
  maxLife: Duration.hours(3),
  size,
});

describe("Namespace macOS Provider", () => {
  it.effect("macOS create asks Namespace for a 4 CPU 7168 MB arm64 Mac", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac();
      // When
      const info = yield* mac.provider.create(createMac());
      // Then
      const [request] = yield* Ref.get(mac.requests);
      expect(request?.shape).toEqual({
        os: "macos",
        machineArch: "arm64",
        virtualCpu: 4,
        memoryMegabytes: 7168,
        selectors: [{ name: "macos.version", value: "26.x" }],
      });
      expect(request?.labels).toContainEqual({
        name: "proofbox.os",
        value: "macos",
      });
      expect(request?.labels).toContainEqual({
        name: "proofbox.size",
        value: "4x7",
      });
      expect(info.name).toBe("us:abc123def4567");
      expect(info.os).toBe("macos");
      expect(info.size).toEqual({ cpu: 4, ramGb: 7 });
    }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "macOS create --size 6x14 asks Namespace for a 6 CPU 14336 MB Mac",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac();
        // When
        yield* mac.provider.create(createMac({ cpu: 6, ramGb: 14 }));
        // Then
        const [request] = yield* Ref.get(mac.requests);
        expect(request?.shape.virtualCpu).toBe(6);
        expect(request?.shape.memoryMegabytes).toBe(14336);
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect("macOS create asks for idle plus 60 s and arms the Max life", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac();
      yield* TestClock.setTime(0);
      // When
      const info = yield* mac.provider.create(createMac());
      // Then
      const [request] = yield* Ref.get(mac.requests);
      expect(request?.deadline).toEqual(new Date(360_000));
      expect(info.idleSeconds).toBe(300);
      const expire = (yield* Ref.get(mac.detached)).find(
        ([rel]) => rel === "namespace/expire-main",
      );
      expect(expire?.[1][0]).toBe("us:abc123def4567");
    }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "extend on a Mac writes the Deadline file and pushes the host",
    () => {
      const runtime = runtimeDir();
      writeFileSync(join(runtime, "ns-us:abc123def4567.os"), "macos");
      return Effect.gen(function* () {
        // Given
        const mac = yield* makeMac();
        yield* TestClock.setTime(0);
        // When
        yield* mac.provider.extend("us:abc123def4567", new Date(300_000));
        // Then
        expect(yield* Ref.get(mac.detached)).toContainEqual([
          "namespace/extend-main",
          ["us:abc123def4567", "300"],
        ]);
        const lines = yield* Ref.get(mac.commands);
        expect(lines.some((line) => line.includes("/deadline"))).toBe(true);
        expect(lines.some((line) => line.includes("docker exec"))).toBe(false);
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "macOS create fetches ffmpeg through nsc artifact cache-url and checks every hash",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac();
        // When
        yield* mac.provider.create(createMac());
        // Then
        const lines = yield* Ref.get(mac.commands);
        expect(
          lines.some((line) =>
            line.includes(
              "/opt/nsc/bin/nsc artifact cache-url 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip'",
            ),
          ),
        ).toBe(true);
        const shasum = lines.find((line) => line.startsWith("shasum -a 256"));
        for (const tool of TOOL_BUNDLE.filter((tool) => tool.macos)) {
          expect(shasum).toContain(`'${tool.path}'`);
        }
        expect(lines.some((line) => line.includes("brew"))).toBe(false);
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect("a Tool bundle file with the wrong hash deletes the Mac", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac((line) =>
        line.startsWith("shasum -a 256")
          ? {
              stdout:
                "0000000000000000000000000000000000000000000000000000000000000000  /opt/proofbox/tools/ffmpeg\n",
            }
          : undefined,
      );
      // When
      const error = yield* Effect.flip(mac.provider.create(createMac()));
      // Then
      expect(error.message).toBe(
        "Tool bundle file /opt/proofbox/tools/ffmpeg has the wrong hash; deleted ns:us:abc123def4567. Run create again",
      );
      expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
    }).pipe(withRuntime(runtimeDir())),
  );

  it.effect("macOS create runs the prepare steps in order", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac();
      // When
      yield* mac.provider.create(createMac());
      // Then
      const lines = yield* Ref.get(mac.commands);
      const at = (text: string) =>
        lines.findIndex((line) => line.includes(text));
      expect(at("nsc artifact cache-url")).toBeGreaterThanOrEqual(0);
      expect(at("nsc artifact cache-url")).toBeLessThan(
        at("rm -f /var/run/nsc/token.json"),
      );
      expect(at("rm -f /var/run/nsc/token.json")).toBeLessThan(
        at("test ! -e /var/run/nsc/token.json"),
      );
      expect(at("test ! -e /var/run/nsc/token.json")).toBeLessThan(
        at("screencapture"),
      );
      // The Mac is a Sandbox only once it is prepared.
      expect(at("/tmp/proofbox-test.mov")).toBeLessThan(at("labels.json"));
      // In a folder runner cannot write, so user code cannot fake a kill.
      expect(
        at(">> /var/log/proofbox-memory-kills.log"),
      ).toBeGreaterThanOrEqual(0);
    }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "macOS create refuses and deletes the Mac when the token file is still there",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac((line) =>
          line.includes("test ! -e /var/run/nsc/token.json")
            ? { exitCode: 1 }
            : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        expect(error.message).toBe(
          "Sandbox ns:us:abc123def4567 can reach the Namespace workload token (the token file); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "macOS create refuses and deletes the Mac when the Docker config is still there",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac((line) =>
          line.includes("test ! -e /Users/runner/.docker/config.json")
            ? { exitCode: 1 }
            : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        expect(error.message).toBe(
          "Sandbox ns:us:abc123def4567 can reach the Namespace workload token (the Docker config token); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect("a blocked test screenshot fails create and deletes the Mac", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac((line) =>
        line.includes("/tmp/proofbox-test.png") ? { exitCode: 1 } : undefined,
      );
      // When
      const error = yield* Effect.flip(mac.provider.create(createMac()));
      // Then
      expect(error.message).toBe(
        "Sandbox ns:us:abc123def4567 failed the macOS prepare check (the test screenshot is blocked); deleted the Mac",
      );
      expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
    }).pipe(withRuntime(runtimeDir())),
  );

  const PngHead = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  it.effect(
    "a blocked test capture fails create, saves the screen, and deletes the Mac",
    () => {
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given
        const mac = yield* makeMac((line) =>
          line.includes("/tmp/proofbox-test.mov")
            ? { exitCode: 1 }
            : line.includes("/tmp/proofbox-fail.png")
              ? { stdout: PngHead }
              : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        const saved = join(runtime, "ns-us:abc123def4567-prepare.png");
        expect(error.message).toBe(
          `Sandbox ns:us:abc123def4567 failed the macOS prepare check (the test capture is blocked); saved the screen to ${saved} and deleted the Mac`,
        );
        expect(new Uint8Array(readFileSync(saved))).toEqual(PngHead);
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "a blocked test capture whose screen cannot be saved names no screenshot",
    () => {
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given: the saving screencapture is blocked too
        const mac = yield* makeMac((line) =>
          line.includes("/tmp/proofbox-test.mov")
            ? { exitCode: 1 }
            : line.includes("/tmp/proofbox-fail.png")
              ? { exitCode: 1 }
              : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        expect(error.message).toBe(
          "Sandbox ns:us:abc123def4567 failed the macOS prepare check (the test capture is blocked); deleted the Mac",
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "a test capture that hangs names the alert, saves the screen, and deletes the Mac",
    () => {
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given: the capture is killed by its 15 s timer
        const mac = yield* makeMac((line) =>
          line.includes("/tmp/proofbox-test.mov")
            ? { exitCode: 137 }
            : line.includes("/tmp/proofbox-fail.png")
              ? { stdout: PngHead }
              : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        const saved = join(runtime, "ns-us:abc123def4567-prepare.png");
        expect(error.message).toBe(
          `Sandbox ns:us:abc123def4567 failed the macOS prepare check (an alert is on screen); saved the screen to ${saved} and deleted the Mac`,
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "a replayd alert at the test capture names the alert, saves the screen, and deletes the Mac",
    () => {
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given: replayd showed its alert and moved the hint date
        const mac = yield* makeMac((line) =>
          line.startsWith("plutil -extract")
            ? { stdout: "2026-10-28T17:49:21Z\n" }
            : line.includes("/tmp/proofbox-fail.png")
              ? { stdout: PngHead }
              : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        const saved = join(runtime, "ns-us:abc123def4567-prepare.png");
        expect(error.message).toBe(
          `Sandbox ns:us:abc123def4567 failed the macOS prepare check (an alert is on screen); saved the screen to ${saved} and deleted the Mac`,
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "macOS create refuses and deletes the Mac when the RAM disk cannot be made",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac((line) =>
          line.includes("hdiutil attach -nomount ram://16384")
            ? { exitCode: 1 }
            : undefined,
        );
        // When
        const error = yield* Effect.flip(mac.provider.create(createMac()));
        // Then
        expect(error.message).toBe(
          "Sandbox ns:us:abc123def4567 failed the macOS prepare check (the Secrets RAM disk cannot be made); deleted the Mac",
        );
        expect(yield* Ref.get(mac.calls)).toContain("destroy us abc123def4567");
        const lines = yield* Ref.get(mac.commands);
        expect(lines.some((line) => line.includes("labels.json"))).toBe(false);
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "macOS create makes the Secrets RAM disk after the token is gone and before the test capture",
    () =>
      Effect.gen(function* () {
        // Given
        const mac = yield* makeMac();
        // When
        yield* mac.provider.create(createMac());
        // Then
        const lines = yield* Ref.get(mac.commands);
        const at = (text: string) =>
          lines.findIndex((line) => line.includes(text));
        expect(at("hdiutil attach -nomount ram://16384")).toBeGreaterThan(
          at("test ! -e /var/run/nsc/token.json"),
        );
        expect(at("hdiutil attach -nomount ram://16384")).toBeLessThan(
          at("/tmp/proofbox-test.mov"),
        );
      }).pipe(withRuntime(runtimeDir())),
  );

  it.effect("macOS create restarts replayd after it writes the approval", () =>
    Effect.gen(function* () {
      // Given
      const mac = yield* makeMac();
      // When
      yield* mac.provider.create(createMac());
      // Then
      const lines = yield* Ref.get(mac.commands);
      const approval = lines.findIndex((line) =>
        line.includes("kScreenCaptureApprovalLastAlerted"),
      );
      const restart = lines.findIndex((line) =>
        line.includes("killall -9 replayd"),
      );
      const capture = lines.findIndex((line) =>
        line.includes("/tmp/proofbox-test.png"),
      );
      expect(approval).toBeGreaterThanOrEqual(0);
      expect(restart).toBeGreaterThanOrEqual(approval);
      expect(restart).toBeLessThan(capture);
    }).pipe(withRuntime(runtimeDir())),
  );

  it.effect(
    "a Mac whose prepare outlasts the idle time gets its Deadline from the end of prepare",
    () =>
      Effect.gen(function* () {
        // Given: the Tool bundle check takes 10 minutes, past idle plus 60 s
        const mac = yield* makeMac(undefined, (line) =>
          line.startsWith("shasum -a 256")
            ? TestClock.adjust(Duration.minutes(10))
            : Effect.void,
        );
        yield* TestClock.setTime(0);
        // When
        const info = yield* mac.provider.create(createMac());
        // Then
        expect(info.createdAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
        expect(info.deadline.toISOString()).toBe("1970-01-01T00:16:00.000Z");
        const lines = yield* Ref.get(mac.commands);
        expect(lines.find((line) => line.includes("/deadline"))).toContain(
          "960",
        );
      }).pipe(withRuntime(runtimeDir())),
  );

  it("countMemoryKills counts kernel kills and skips idle-daemon kills", () => {
    // Given: JETSAM_LINES
    // When
    const count = countMemoryKills(JETSAM_LINES);
    // Then
    expect(count).toBe(2);
  });

  it.effect("memoryKills on a Mac counts the watcher's log", () => {
    const runtime = runtimeDir();
    writeFileSync(join(runtime, "ns-us:abc123def4567.os"), "macos");
    return Effect.gen(function* () {
      // Given
      const mac = yield* makeMac((line) =>
        line.includes("grep 'memorystatus: killing_'")
          ? { stdout: `${JETSAM_LINES}\n` }
          : undefined,
      );
      // When
      const kills = yield* mac.provider.memoryKills("us:abc123def4567");
      // Then
      expect(kills).toBe(2);
    }).pipe(withRuntime(runtime));
  });

  it.effect(
    "memoryKills on a Mac starts the watcher again when it stopped",
    () => {
      const runtime = runtimeDir();
      writeFileSync(join(runtime, "ns-us:abc123def4567.os"), "macos");
      return Effect.gen(function* () {
        // Given: the watcher's pid is not running
        const mac = yield* makeMac();
        // When
        yield* mac.provider.memoryKills("us:abc123def4567");
        // Then
        const [line] = yield* Ref.get(mac.commands);
        expect(line).toMatch(
          /^ps -p "\$\(cat \/var\/run\/proofbox-memory-watch\.pid 2>\/dev\/null\)" >\/dev\/null 2>&1 \|\| sudo -n sh -c .*\/usr\/bin\/log stream/,
        );
        expect(line).toContain("grep 'memorystatus: killing_'");
      }).pipe(withRuntime(runtime));
    },
  );

  it.effect(
    "a Mac Live view sets the VNC password and forwards port 5900",
    () => {
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given: the VNC password script prints the settled password
        const mac = yield* makeMac(
          (line) =>
            line.includes("-setvnclegacy")
              ? { stdout: "Xy7kQ2mA\n" }
              : undefined,
          undefined,
          () => Effect.succeed({ port: 50123, gone: Effect.never }),
        );
        yield* mac.provider.create(createMac());
        // When
        const liveView = mac.provider.liveView;
        const view = yield* liveView === undefined
          ? Effect.die("no liveView")
          : liveView("us:abc123def4567");
        // Then
        expect(view.address).toBe("127.0.0.1:50123");
        expect(view.password).toBe("Xy7kQ2mA");
        expect(yield* Ref.get(mac.calls)).toContain(
          "portForward us:abc123def4567 5900",
        );
      }).pipe(Effect.scoped, withRuntime(runtime));
    },
  );

  it.effect("closing the last Mac Live view turns VNC off", () => {
    const runtime = runtimeDir();
    return Effect.gen(function* () {
      // Given: the VNC password script prints the settled password
      const mac = yield* makeMac(
        (line) =>
          line.includes("-setvnclegacy") ? { stdout: "Xy7kQ2mA\n" } : undefined,
        undefined,
        () => Effect.succeed({ port: 50123, gone: Effect.never }),
      );
      yield* mac.provider.create(createMac());
      // When: a Live view opens and its scope closes
      const liveView = mac.provider.liveView;
      yield* (
        liveView === undefined
          ? Effect.die("no liveView")
          : liveView("us:abc123def4567")
      ).pipe(Effect.scoped);
      // Then
      const lines = yield* Ref.get(mac.commands);
      const last = lines.at(-1);
      expect(last).toContain('rm -f "$L/$1"');
      expect(last).toContain("kickstart -deactivate");
    }).pipe(withRuntime(runtime));
  });
});
