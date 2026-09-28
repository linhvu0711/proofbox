import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
  Chunk,
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
  readonly ran?: { image?: string | undefined };
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
        if (options.ran !== undefined) {
          options.ran.image = args[args.length - 1];
        }
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

const liveLayers = (warnings?: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.mergeAll(
    CliOutput.Test,
    // A heartbeat-less Progress, like test/deadline.test.ts.
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn:
          warnings === undefined
            ? () => Effect.void
            : (text) => Ref.update(warnings, (all) => [...all, text]),
      }),
    ),
  );

const makeProvider = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  docker: DockerClient,
  run?: (
    commandLine: string,
  ) => { exitCode: number; stdout: string; stderr: string } | undefined,
) =>
  makeNamespaceProvider({
    nsc: fakeNsc(calls),
    openLink: () =>
      Effect.succeed<Link>({
        ssh: [],
        run: (commandLine) =>
          Effect.succeed(
            commandLine.includes("metadata.json")
              ? { exitCode: 0, stdout: "tenant_x\n", stderr: "" }
              : (run?.(commandLine) ?? {
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                }),
          ),
      }),
    dockerFor: () => docker,
    spawnDetached: () => Effect.void,
  });

const runtimeDir = Effect.withConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      [
        "PROOFBOX_RUNTIME_DIR",
        mkdtempSync(join(tmpdir(), "proofbox-runtime-")),
      ],
    ]),
  ),
);

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

  it.effect(
    "create from a known Fingerprint runs the Snapshot image and keeps it 336h",
    () =>
      Effect.gen(function* () {
        // Given: a Snapshot pull that answers, and a RepoDigests line for it
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const commands: string[] = [];
        const ran: { image?: string | undefined } = {};
        const provider = makeProvider(
          calls,
          fakeDocker({ ran }),
          (commandLine) => {
            commands.push(commandLine);
            if (commandLine.startsWith("docker pull ")) {
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            if (commandLine.includes("docker image inspect")) {
              return {
                exitCode: 0,
                stdout:
                  "nscr.io/tenant_x/proofbox-snapshot-linux@sha256:ab12\n",
                stderr: "",
              };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        );
        // When
        const info = yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        });
        // Then
        expect(ran.image).toBe(
          "nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e",
        );
        expect(info.snapshot).toBe("22d0cf15eb8e");
        expect(commands).toContain(
          "/nsc/bin/nsc registry update-image-expiration proofbox-snapshot-linux@sha256:ab12 --ensure-minimum 336h </dev/null",
        );
      }).pipe(runtimeDir, Effect.provide(liveLayers())),
  );

  it.effect("create from an unknown Fingerprint runs the Base image", () =>
    Effect.gen(function* () {
      // Given: a Snapshot pull whose registry knows no such manifest
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const commands: string[] = [];
      const ran: { image?: string | undefined } = {};
      const provider = makeProvider(
        calls,
        fakeDocker({ ran }),
        (commandLine) => {
          commands.push(commandLine);
          if (commandLine.startsWith("docker pull ")) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "Error response from daemon: manifest unknown\n",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      );
      // When
      const info = yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
        snapshot: "22d0cf15eb8e",
      });
      // Then
      expect(ran.image).toMatch(
        /^nscr\.io\/tenant_x\/proofbox-base-linux:[0-9a-f]{12}$/,
      );
      expect(info.snapshot).toBeUndefined();
      expect(
        commands.some((line) => line.includes("update-image-expiration")),
      ).toBe(false);
      const output = yield* CliOutput;
      expect(
        Chunk.toReadonlyArray(yield* Ref.get(output.captured.err)).join(""),
      ).not.toContain("could not");
    }).pipe(runtimeDir, Effect.provide(liveLayers())),
  );

  it.effect("a failed Snapshot pull warns and runs the Base image", () =>
    Effect.gen(function* () {
      // Given: a Snapshot pull that fails with a network error
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
      const ran: { image?: string | undefined } = {};
      const provider = makeProvider(
        calls,
        fakeDocker({ ran }),
        (commandLine) => {
          if (commandLine.startsWith("docker pull ")) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "dial tcp: i/o timeout\n",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      );
      // When
      const info = yield* provider
        .create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        })
        .pipe(Effect.provide(liveLayers(warnings)));
      // Then
      expect(ran.image).toMatch(
        /^nscr\.io\/tenant_x\/proofbox-base-linux:[0-9a-f]{12}$/,
      );
      expect(info.snapshot).toBeUndefined();
      expect(yield* Ref.get(warnings)).toEqual([
        "could not pull the Snapshot (Provider namespace failed: docker pull failed: dial tcp: i/o timeout); running the Setup script",
      ]);
    }).pipe(runtimeDir),
  );

  it.effect(
    "save commits the container, pushes it under its Fingerprint, and keeps it 336h",
    () =>
      Effect.gen(function* () {
        // Given: a Snapshot registry that accepts the push
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const commands: string[] = [];
        const provider = makeProvider(calls, fakeDocker({}), (commandLine) => {
          commands.push(commandLine);
          if (commandLine.includes("docker image inspect")) {
            return {
              exitCode: 0,
              stdout: "nscr.io/tenant_x/proofbox-snapshot-linux@sha256:ab12\n",
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        });
        // When
        const snapshots = provider.snapshots;
        if (snapshots === undefined) {
          return yield* Effect.die("provider has no snapshots member");
        }
        yield* snapshots.save("abc123def4567", "22d0cf15eb8e");
        // Then
        expect(commands).toContain(
          "docker commit proofbox-abc123 nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e && docker push nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e",
        );
        expect(commands).toContain(
          "/nsc/bin/nsc registry update-image-expiration proofbox-snapshot-linux@sha256:ab12 --ensure-minimum 336h </dev/null",
        );
      }).pipe(runtimeDir, Effect.provide(liveLayers())),
  );

  it.effect("a failed push fails save with the docker error", () =>
    Effect.gen(function* () {
      // Given: a Snapshot registry that refuses the push
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const commands: string[] = [];
      const provider = makeProvider(calls, fakeDocker({}), (commandLine) => {
        commands.push(commandLine);
        if (commandLine.includes("docker push")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "denied: requested access to the resource is denied\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      // When
      const snapshots = provider.snapshots;
      if (snapshots === undefined) {
        return yield* Effect.die("provider has no snapshots member");
      }
      const error = yield* Effect.flip(
        snapshots.save("abc123def4567", "22d0cf15eb8e"),
      );
      // Then
      expect(error.message).toBe(
        "Provider namespace failed: docker push failed: denied: requested access to the resource is denied",
      );
      expect(
        commands.some((line) => line.includes("update-image-expiration")),
      ).toBe(false);
    }).pipe(runtimeDir, Effect.provide(liveLayers())),
  );
});
