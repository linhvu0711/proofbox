import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import type { DockerClient } from "../src/docker/docker-client.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type { NscClient } from "../src/namespace/nsc-client.ts";
import type { Link } from "../src/namespace/ssh-link.ts";
import { Progress } from "../src/progress.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";

const fakeNsc = (calls: Ref.Ref<ReadonlyArray<string>>): NscClient => ({
  checkLogin: Ref.update(calls, (all) => [...all, "checkLogin"]),
  create: () =>
    Ref.update(calls, (all) => [...all, "create"]).pipe(
      Effect.as("abc123def4567"),
    ),
  destroy: (id) => Ref.update(calls, (all) => [...all, `destroy ${id}`]),
  extend: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  portForward: () => Effect.die("unused"),
});

const fakeDocker = (options: {
  readonly tokenFile?: number;
  readonly tokenService?: number;
}): DockerClient => {
  let labels: Record<string, string> = {};
  const ok = (stdout = "") =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  return {
    serverArch: Effect.succeed("amd64"),
    imageExists: () => Effect.succeed(true),
    pull: () => Effect.succeed(true),
    push: () => Effect.void,
    build: () => Effect.void,
    run: (args) =>
      Effect.sync(() => {
        labels = {};
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] === "--label") {
            const [key, value] = (args[i + 1] ?? "").split("=", 2);
            if (key !== undefined && value !== undefined) {
              labels[key] = value;
            }
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    execText: (_container, _user, argv) => {
      const line = argv.join(" ");
      if (argv[0] === "sha256sum") {
        const file = TOOL_BUNDLE.find((tool) => tool.path === argv[1]);
        return ok(`${file?.linux.amd64.sha256 ?? ""}  ${argv[1]}\n`);
      }
      if (line.includes("xdpyinfo")) {
        return ok();
      }
      if (line.includes("/run/proofbox/deadline")) {
        return ok("9999999999\n");
      }
      if (line.includes("/var/run/nsc/token.json")) {
        return Effect.succeed({
          exitCode: options.tokenFile ?? 0,
          stdout: "",
          stderr: "",
        });
      }
      if (line.includes("169.254.169.42")) {
        return Effect.succeed({
          exitCode: options.tokenService ?? 0,
          stdout: "",
          stderr: "",
        });
      }
      return ok();
    },
    execStream: () => Stream.empty,
    inspect: () =>
      Effect.succeed(Option.some({ labels: { ...labels }, running: true })),
    listNames: Effect.succeed([]),
    remove: () => Effect.void,
  };
};

const liveLayers = () =>
  Layer.mergeAll(
    CliOutput.Test,
    // A heartbeat-less Progress, like test/deadline.test.ts.
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: () => Effect.void,
      }),
    ),
  );

const makeProvider = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  docker: DockerClient,
) =>
  makeNamespaceProvider({
    nsc: fakeNsc(calls),
    openLink: () =>
      Effect.succeed<Link>({
        ssh: [],
        run: (commandLine) =>
          Effect.succeed({
            exitCode: 0,
            stdout: commandLine.includes("metadata.json") ? "tenant_x\n" : "",
            stderr: "",
          }),
      }),
    dockerFor: () => docker,
    spawnDetached: () => Effect.void,
  });

describe("Namespace Provider", () => {
  it.effect(
    "extend writes the Deadline and starts nsc extend for the seconds left",
    () =>
      Effect.gen(function* () {
        // Given
        const commands = yield* Ref.make<ReadonlyArray<string>>([]);
        const link: Link = {
          ssh: [],
          run: (commandLine) =>
            Ref.update(commands, (all) => [...all, commandLine]).pipe(
              Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
            ),
        };
        const spawned = yield* Ref.make<
          ReadonlyArray<readonly [string, string, ReadonlyArray<string>]>
        >([]);
        const provider = makeNamespaceProvider({
          nsc: fakeNsc(yield* Ref.make<ReadonlyArray<string>>([])),
          openLink: () => Effect.succeed(link),
          dockerFor: () => {
            throw new Error("unused");
          },
          spawnDetached: (provider, rel, args) =>
            Ref.update(spawned, (all) => [
              ...all,
              [provider, rel, args] as const,
            ]),
        });
        yield* TestClock.setTime(new Date("1970-01-01T00:10:00Z").getTime());
        // When
        yield* provider.extend(
          "abc123def4567",
          new Date("1970-01-01T00:25:00Z"),
        );
        // Then
        const seen = yield* Ref.get(commands);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("docker exec -u root proofbox-abc123");
        expect(seen[0]).toContain("900");
        expect(yield* Ref.get(spawned)).toEqual([
          ["namespace", "namespace/extend-main", ["abc123def4567", "900"]],
          ["namespace", "namespace/extend-main", ["abc123def4567", "120"]],
        ]);
      }),
  );

  it.effect(
    "create refuses and deletes the host when the token file is visible",
    () =>
      Effect.gen(function* () {
        // Given: a create whose token-file check exits non-zero
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({ tokenFile: 1 }));
        // When
        const error = yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect(error.message).toBe(
          "Sandbox ns:abc123def4567 can reach the Namespace workload token (the token file); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(calls)).toContain("destroy abc123def4567");
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              [
                "PROOFBOX_RUNTIME_DIR",
                mkdtempSync(join(tmpdir(), "proofbox-runtime-")),
              ],
            ]),
          ),
        ),
        Effect.provide(liveLayers()),
      ),
  );

  it.effect(
    "create refuses and deletes the host when the token service answers",
    () =>
      Effect.gen(function* () {
        // Given: a create whose token-service check exits non-zero
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(
          calls,
          fakeDocker({ tokenFile: 0, tokenService: 1 }),
        );
        // When
        const error = yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect(error.message).toBe(
          "Sandbox ns:abc123def4567 can reach the Namespace workload token (the token service); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(calls)).toContain("destroy abc123def4567");
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              [
                "PROOFBOX_RUNTIME_DIR",
                mkdtempSync(join(tmpdir(), "proofbox-runtime-")),
              ],
            ]),
          ),
        ),
        Effect.provide(liveLayers()),
      ),
  );
});
