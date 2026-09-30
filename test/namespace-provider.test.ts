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
  Redacted,
  Ref,
  Stream,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import type { DockerClient } from "../src/docker/docker-client.ts";
import type {
  InstanceListed,
  NamespaceApi,
} from "../src/namespace/namespace-api.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type { NscClient } from "../src/namespace/nsc-client.ts";
import type { Link } from "../src/namespace/ssh-link.ts";
import { Progress } from "../src/progress.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";

// The Compute API, faked: each call lands in `calls` as
// `<method> <region> <instanceId?>`; `create` answers the id below.
const fakeApi = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  instances: ReadonlyArray<InstanceListed> = [],
): NamespaceApi => {
  const note = (line: string) => Ref.update(calls, (all) => [...all, line]);
  return {
    create: (region) =>
      note(`create ${region}`).pipe(Effect.as("abc123def4567")),
    wait: (region, instanceId) => note(`wait ${region} ${instanceId}`),
    destroy: (region, instanceId) => note(`destroy ${region} ${instanceId}`),
    extend: (region, instanceId) => note(`extend ${region} ${instanceId}`),
    list: (region, labels) =>
      note(`list ${region}`).pipe(
        Effect.as(
          instances.filter((instance) =>
            labels.every(
              (label) => instance.labels[label.name] === label.value,
            ),
          ),
        ),
      ),
    checkToken: () => Effect.die("unused"),
  };
};

const fakeNsc = (calls: Ref.Ref<ReadonlyArray<string>>): NscClient => ({
  checkLogin: Effect.die("unused"),
  create: () => Effect.die("unused"),
  destroy: () => Effect.die("unused"),
  extend: () => Effect.die("unused"),
  ensureImageExpiry: (image, hours) =>
    Ref.update(calls, (all) => [...all, `ensureImageExpiry ${image} ${hours}`]),
  list: () => Effect.die("unused"),
  portForward: () => Effect.die("unused"),
});

const fakeDocker = (options: {
  readonly tokenFile?: number;
  readonly tokenService?: number;
  // Collects the image of every `docker run`, its last argument.
  readonly images?: Array<string>;
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
        options.images?.push(args[args.length - 1] ?? "");
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
        return ok(`${file?.linux?.amd64.sha256 ?? ""}  ${argv[1]}\n`);
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

const liveLayers = (warnings?: Array<string>) =>
  Layer.mergeAll(
    CliOutput.Test,
    // A heartbeat-less Progress, like test/deadline.test.ts.
    Layer.succeed(
      Progress,
      new Progress({
        step: (_label, effect) => effect,
        warn: (text) =>
          Effect.sync(() => {
            warnings?.push(text);
          }),
      }),
    ),
  );

const runtimeConfig = () =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        [
          "PROOFBOX_RUNTIME_DIR",
          mkdtempSync(join(tmpdir(), "proofbox-runtime-")),
        ],
      ]),
    ),
  );

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const done = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });

const tenantRun = (commandLine: string) =>
  Effect.succeed(
    done(commandLine.includes("metadata.json") ? "tenant_x\n" : ""),
  );

// A link that answers the Snapshot's docker commands; `ran` collects
// every command line it got.
const snapshotRun =
  (
    answers: { readonly pull?: RunResult; readonly push?: RunResult },
    ran?: Array<string>,
  ) =>
  (commandLine: string) =>
    Effect.sync(() => {
      ran?.push(commandLine);
      if (commandLine.startsWith("docker pull")) {
        return answers.pull ?? done();
      }
      if (commandLine.startsWith("docker commit")) {
        return answers.push ?? done();
      }
      if (commandLine.startsWith("docker image inspect")) {
        return done("nscr.io/tenant_x/proofbox-snapshot-linux@sha256:ab12\n");
      }
      return done(commandLine.includes("metadata.json") ? "tenant_x\n" : "");
    });

const BASE_IMAGE = /^nscr\.io\/tenant_x\/proofbox-base-linux:[0-9a-f]{12}$/;

const makeProvider = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  docker: DockerClient,
  run: Link["run"] = tenantRun,
  options?: {
    readonly instances?: ReadonlyArray<InstanceListed>;
    readonly region?: string;
  },
) =>
  makeNamespaceProvider({
    api: fakeApi(calls, options?.instances ?? []),
    login: Effect.succeed({
      token: Redacted.make("token"),
      region: Option.fromNullable(options?.region),
    }),
    nsc: fakeNsc(calls),
    openLink: () =>
      Effect.succeed<Link>({
        ssh: [],
        stream: () => Stream.empty,
        run,
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
          stream: () => Stream.empty,
          run: (commandLine) =>
            Ref.update(commands, (all) => [...all, commandLine]).pipe(
              Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
            ),
        };
        const spawned = yield* Ref.make<
          ReadonlyArray<readonly [string, string, ReadonlyArray<string>]>
        >([]);
        const provider = makeNamespaceProvider({
          api: fakeApi(yield* Ref.make<ReadonlyArray<string>>([])),
          login: Effect.die("unused"),
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
          "us:abc123def4567",
          new Date("1970-01-01T00:25:00Z"),
        );
        // Then
        const seen = yield* Ref.get(commands);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("docker exec -u root proofbox-abc123");
        expect(seen[0]).toContain("900");
        expect(yield* Ref.get(spawned)).toEqual([
          ["namespace", "namespace/extend-main", ["us:abc123def4567", "900"]],
          ["namespace", "namespace/extend-main", ["us:abc123def4567", "120"]],
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
          "Sandbox ns:us:abc123def4567 can reach the Namespace workload token (the token file); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(calls)).toContain("destroy us abc123def4567");
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
          "Sandbox ns:us:abc123def4567 can reach the Namespace workload token (the token service); deleted the host and refused the Sandbox",
        );
        expect(yield* Ref.get(calls)).toContain("destroy us abc123def4567");
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
        // Given: the registry has the Snapshot
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const images: Array<string> = [];
        const provider = makeProvider(
          calls,
          fakeDocker({ images }),
          snapshotRun({}),
        );
        // When
        const info = yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        });
        // Then
        expect({
          image: images[0],
          snapshot: info.snapshot,
          expiry: (yield* Ref.get(calls)).filter((call) =>
            call.startsWith("ensureImageExpiry"),
          ),
        }).toEqual({
          image: "nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e",
          snapshot: "22d0cf15eb8e",
          expiry: ["ensureImageExpiry proofbox-snapshot-linux@sha256:ab12 336"],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("create from an unknown Fingerprint runs the Base image", () => {
    const warnings: Array<string> = [];
    return Effect.gen(function* () {
      // Given: the registry has no such Snapshot
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const images: Array<string> = [];
      const provider = makeProvider(
        calls,
        fakeDocker({ images }),
        snapshotRun({
          pull: {
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: manifest unknown\n",
          },
        }),
      );
      // When
      const info = yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
        snapshot: "22d0cf15eb8e",
      });
      // Then
      expect({
        baseImage: BASE_IMAGE.test(images[0] ?? ""),
        snapshot: info.snapshot,
        expiry: (yield* Ref.get(calls)).filter((call) =>
          call.startsWith("ensureImageExpiry"),
        ),
        warnings,
      }).toEqual({
        baseImage: true,
        snapshot: undefined,
        expiry: [],
        warnings: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
  });

  it.effect("a failed Snapshot pull warns and runs the Base image", () => {
    const warnings: Array<string> = [];
    return Effect.gen(function* () {
      // Given: the registry does not answer
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const images: Array<string> = [];
      const provider = makeProvider(
        calls,
        fakeDocker({ images }),
        snapshotRun({
          pull: { exitCode: 1, stdout: "", stderr: "dial tcp: i/o timeout\n" },
        }),
      );
      // When
      yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
        snapshot: "22d0cf15eb8e",
      });
      // Then
      expect({
        warnings,
        baseImage: BASE_IMAGE.test(images[0] ?? ""),
      }).toEqual({
        warnings: [
          "could not pull the Snapshot (Provider namespace failed: docker pull failed: dial tcp: i/o timeout); running the Setup script",
        ],
        baseImage: true,
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
  });

  it.effect(
    "save commits the container, pushes it under its Fingerprint, and keeps it 336h",
    () =>
      Effect.gen(function* () {
        // Given: every command on the link succeeds
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const ran: Array<string> = [];
        const provider = makeProvider(
          calls,
          fakeDocker({}),
          snapshotRun({}, ran),
        );
        const snapshots = yield* Effect.fromNullable(provider.snapshots).pipe(
          Effect.orDie,
        );
        // When
        yield* snapshots.save("abc123def4567", "22d0cf15eb8e");
        // Then
        expect({
          pushed: ran.filter((line) => line.startsWith("docker commit")),
          expiry: (yield* Ref.get(calls)).filter((call) =>
            call.startsWith("ensureImageExpiry"),
          ),
        }).toEqual({
          pushed: [
            "docker commit --pause=false proofbox-abc123 nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e && docker push nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e",
          ],
          expiry: ["ensureImageExpiry proofbox-snapshot-linux@sha256:ab12 336"],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("a failed push fails save with the docker error", () =>
    Effect.gen(function* () {
      // Given: the registry refuses the push
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        snapshotRun({
          push: {
            exitCode: 1,
            stdout: "",
            stderr: "denied: requested access to the resource is denied\n",
          },
        }),
      );
      const snapshots = yield* Effect.fromNullable(provider.snapshots).pipe(
        Effect.orDie,
      );
      // When
      const error = yield* Effect.flip(
        snapshots.save("abc123def4567", "22d0cf15eb8e"),
      );
      // Then
      expect({
        message: error.message,
        expiry: (yield* Ref.get(calls)).filter((call) =>
          call.startsWith("ensureImageExpiry"),
        ),
      }).toEqual({
        message:
          "Provider namespace failed: docker push failed: denied: requested access to the resource is denied",
        expiry: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("create in the login's region returns a region id", () =>
    Effect.gen(function* () {
      // Given: a login whose token carries no region
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}));
      // When
      const info = yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      });
      // Then
      expect(info.name).toBe("us:abc123def4567");
      expect((yield* Ref.get(calls)).slice(0, 2)).toEqual([
        "create us",
        "wait us abc123def4567",
      ]);
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("create goes to the region of an eu login", () =>
    Effect.gen(function* () {
      // Given: a login in eu
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
        region: "eu",
      });
      // When
      const info = yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      });
      // Then
      expect(info.name).toBe("eu:abc123def4567");
      expect((yield* Ref.get(calls)).slice(0, 2)).toEqual([
        "create eu",
        "wait eu abc123def4567",
      ]);
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "delete of a us Sandbox goes to us after the login moved to eu",
    () =>
      Effect.gen(function* () {
        // Given: a us Sandbox in eu's login
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          region: "eu",
          instances: [
            { id: "abc123def4567", labels: { "proofbox.os": "linux" } },
          ],
        });
        // When
        const outcome = yield* provider.delete("us:abc123def4567");
        // Then: us was asked, never eu
        expect(outcome).toBe("deleted");
        expect(yield* Ref.get(calls)).toEqual([
          "list us",
          "list us",
          "destroy us abc123def4567",
        ]);
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );
});
