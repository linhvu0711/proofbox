import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
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
import {
  CHECKS_START,
  checksTrailer,
  pushFailedTrailer,
} from "../src/command-checks.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import type { DockerClient } from "../src/docker/docker-client.ts";
import {
  NotLoggedInError,
  ProviderLimitError,
  ProviderUnavailableError,
  TokenPermissionError,
} from "../src/errors.ts";
import { keeperPaths } from "../src/keeper/paths.ts";
import type {
  ApiError,
  ApiLoginError,
  InstanceListed,
  NamespaceApi,
} from "../src/namespace/namespace-api.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type { Link } from "../src/namespace/ssh-link.ts";
import { Progress } from "../src/progress.ts";
import type { ExecEvent } from "../src/provider.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { nodeExecutor } from "./support/executor.ts";
import { startFakeNamespace, TENANT_1 } from "./support/fake-namespace-api.ts";
import { eventually, startKeeper } from "./support/keeper.ts";
import { nodeFs } from "./support/node-fs.ts";

// The Compute API, faked: each call lands in `calls` as
// `<method> <region> <instanceId?>`; `create` answers the id below.
const fakeApi = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  options?: {
    readonly instances?: ReadonlyArray<
      InstanceListed & { readonly region?: string }
    >;
    // An error that makes a region's `list` fail before any call is made.
    readonly listError?: (
      region: string,
    ) => ApiError | ApiLoginError | undefined;
    // An error the nth `create` call (1-based) fails with.
    readonly createError?: (n: number) => ApiError | ApiLoginError | undefined;
    // An error `ensureImageExpiry` fails with for an image.
    readonly expiryError?: (image: string) => ApiError | undefined;
  },
): NamespaceApi => {
  const note = (line: string) => Ref.update(calls, (all) => [...all, line]);
  let creates = 0;
  return {
    create: (region) =>
      Effect.gen(function* () {
        creates += 1;
        yield* note(`create ${region}`);
        const error = options?.createError?.(creates);
        if (error !== undefined) {
          return yield* error;
        }
        return "abc123def4567";
      }),
    wait: (region, instanceId) => note(`wait ${region} ${instanceId}`),
    destroy: (region, instanceId) => note(`destroy ${region} ${instanceId}`),
    extend: (region, instanceId) => note(`extend ${region} ${instanceId}`),
    list: (region, labels) => {
      const error = options?.listError?.(region);
      if (error !== undefined) {
        return Effect.fail(error);
      }
      return note(`list ${region}`).pipe(
        Effect.as(
          (options?.instances ?? []).filter(
            (instance) =>
              (instance.region === undefined || instance.region === region) &&
              labels.every(
                (label) => instance.labels[label.name] === label.value,
              ),
          ),
        ),
      );
    },
    sshConfig: () => Effect.die("unused"),
    ensureImageExpiry: (image, hours) => {
      const error = options?.expiryError?.(image);
      if (error !== undefined) {
        return Effect.fail(error);
      }
      return note(`ensureImageExpiry ${image} ${hours}`);
    },
    checkToken: () => Effect.die("unused"),
    makeToken: () => Effect.die("unused"),
  };
};

const fakeDocker = (options: {
  readonly tokenFile?: number;
  readonly tokenService?: number;
  // Collects the image of every `docker run`, its last argument.
  readonly images?: Array<string>;
  // Whether the host already has the image, and whether a pull finds it.
  readonly exists?: boolean;
  readonly pulled?: boolean;
  // Collect the tag of every pull and every push.
  readonly pulls?: Array<string>;
  readonly pushed?: Array<string>;
}): DockerClient => {
  let labels: Record<string, string> = {};
  const ok = (stdout = "") =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  return {
    serverArch: Effect.succeed("amd64"),
    imageExists: () => Effect.succeed(options.exists ?? true),
    pull: (tag) =>
      Effect.sync(() => {
        options.pulls?.push(tag);
        return options.pulled ?? true;
      }),
    push: (tag) =>
      Effect.sync(() => {
        options.pushed?.push(tag);
      }),
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

// The Base tag's digests as `docker buildx imagetools inspect` prints
// them: the index and its 2 children.
const BASE_INDEX = JSON.stringify({
  digest: "sha256:ba5e",
  manifests: [{ digest: "sha256:cd34" }, { digest: "sha256:ef56" }],
});

const BASE_EXPIRY = [
  "ensureImageExpiry proofbox-base-linux@sha256:ba5e 336",
  "ensureImageExpiry proofbox-base-linux@sha256:cd34 336",
  "ensureImageExpiry proofbox-base-linux@sha256:ef56 336",
];

const tenantRun = (commandLine: string) => {
  if (commandLine.startsWith("docker buildx imagetools inspect")) {
    return Effect.succeed(done(BASE_INDEX));
  }
  return Effect.succeed(
    done(commandLine.includes("metadata.json") ? "tenant_x\n" : ""),
  );
};

// A link that answers the `docker inspect` `list` runs on each host:
// the container's labels name it by its six-letter host id, and the
// Deadline file reads as far future.
const listRun = (commandLine: string) => {
  if (commandLine.includes("docker inspect")) {
    const short = /proofbox-([a-z0-9]+)/.exec(commandLine)?.[1] ?? "";
    return Effect.succeed(
      done(
        `${JSON.stringify({
          "proofbox.name": short,
          "proofbox.os": "linux",
          "proofbox.created-at": "2026-01-01T00:00:00Z",
          "proofbox.idle-seconds": "300",
          "proofbox.max-life-at": "2099-01-01T00:00:00Z",
        })}|true\n9999999999\n`,
      ),
    );
  }
  return tenantRun(commandLine);
};

// A link that answers the Snapshot's docker commands; `ran` collects
// every command line it got.
const snapshotRun =
  (
    answers: {
      readonly pull?: RunResult;
      readonly push?: RunResult;
      readonly base?: RunResult;
    },
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
      if (commandLine.startsWith("docker buildx imagetools inspect")) {
        return answers.base ?? done(BASE_INDEX);
      }
      return done(commandLine.includes("metadata.json") ? "tenant_x\n" : "");
    });

const BASE_IMAGE = /^nscr\.io\/tenant_x\/proofbox-base-linux:[0-9a-f]{12}$/;

const makeProvider = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  docker: DockerClient,
  run: Link["run"] = tenantRun,
  options?: {
    readonly instances?: ReadonlyArray<
      InstanceListed & { readonly region?: string }
    >;
    readonly listError?: (
      region: string,
    ) => ApiError | ApiLoginError | undefined;
    readonly createError?: (n: number) => ApiError | ApiLoginError | undefined;
    readonly expiryError?: (image: string) => ApiError | undefined;
    readonly region?: string;
  },
) =>
  makeNamespaceProvider({
    executor: nodeExecutor,
    fs: nodeFs,
    api: fakeApi(calls, options),
    login: Effect.succeed({
      token: Redacted.make("token"),
      region: Option.fromNullable(options?.region),
    }),
    openLink: () =>
      Effect.succeed<Link>({
        ssh: [],
        stream: () => Stream.empty,
        run,
      }),
    forward: () => Effect.die("unused"),
    dockerFor: () => docker,
    spawnDetached: () => Effect.void,
  });

describe("Namespace Provider", () => {
  it("exec on a Mac from another machine exits 125 without opening the gateway", async () => {
    // Given: the API labels the Mac, but this machine has no local files.
    const ns = await startFakeNamespace((call) =>
      call.method === "ListInstances"
        ? {
            json: {
              instances: [
                {
                  instanceId: "abc123def4567",
                  labels: [{ name: "proofbox.os", value: "macos" }],
                },
              ],
            },
          }
        : { json: {} },
    );
    const env = makeEnv();
    try {
      // When
      const result = await runCli(
        env,
        ["exec", "ns:us:abc123def4567", "--", "true"],
        {
          set: {
            PROOFBOX_NAMESPACE_TOKEN: TENANT_1,
            PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
          },
        },
      );
      // Then
      expect(result).toEqual({
        stdout: "",
        stderr:
          "Sandbox ns:us:abc123def4567 was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ns:us:abc123def4567\n",
        exitCode: 125,
      });
      expect(ns.calls.some((call) => call.method === "ListInstances")).toBe(
        true,
      );
      expect(ns.calls.some((call) => call.method === "GetSSHConfig")).toBe(
        false,
      );
    } finally {
      cleanupEnvs();
      await ns.close();
    }
  });

  it("exec with no local OS file fails before opening a link when lookup fails", async () => {
    // Given: this machine has no local files and Namespace cannot list hosts.
    const ns = await startFakeNamespace((call) =>
      call.method === "ListInstances"
        ? { error: { code: "unavailable", message: "lookup unavailable" } }
        : { json: {} },
    );
    const env = makeEnv();
    try {
      // When
      const result = await runCli(
        env,
        ["exec", "ns:us:abc123def4567", "--", "true"],
        {
          set: {
            PROOFBOX_NAMESPACE_TOKEN: TENANT_1,
            PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
          },
        },
      );
      // Then
      expect(result).toEqual({
        stdout: "",
        stderr:
          "Could not reach Namespace. Check your network and try again.\n",
        exitCode: 125,
      });
      expect(ns.calls.map((call) => call.method)).toEqual(["ListInstances"]);
      expect(readdirSync(env.runtime)).toEqual([]);
    } finally {
      cleanupEnvs();
      await ns.close();
    }
  });

  it.effect("a host with no local OS file and no OS label stays Linux", () =>
    Effect.gen(function* () {
      // Given: another host is a Mac; the requested host has no OS label.
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), listRun, {
        instances: [
          { id: "other00000001", labels: { "proofbox.os": "macos" } },
          { id: "abc123def4567", labels: {} },
        ],
      });
      // When
      const info = yield* provider.get({ name: "abc123def4567", region: "us" });
      // Then
      expect(info.os).toBe("linux");
      expect(yield* Ref.get(calls)).toContain("list us");
    }).pipe(runtimeConfig()),
  );

  it.effect("a local Linux OS file needs no API lookup", () =>
    Effect.gen(function* () {
      // Given: the local OS file takes precedence over the API label.
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), listRun, {
        instances: [
          { id: "abc123def4567", labels: { "proofbox.os": "macos" } },
        ],
      });
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "us:abc123def4567",
      }).pipe(Effect.provide(NodeContext.layer));
      writeFileSync(paths.os, "linux\n");
      // When
      const info = yield* provider.get({ name: "abc123def4567", region: "us" });
      // Then
      expect(info.os).toBe("linux");
      expect(yield* Ref.get(calls)).toEqual([]);
    }).pipe(runtimeConfig()),
  );

  it.effect("a local Mac OS file needs no API lookup", () =>
    Effect.gen(function* () {
      // Given: this machine knows it is a Mac but has no sshd pin.
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}));
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "us:abc123def4567",
      }).pipe(Effect.provide(NodeContext.layer));
      writeFileSync(paths.os, "macos\n");
      // When
      const error = yield* provider
        .get({ name: "abc123def4567", region: "us" })
        .pipe(Effect.flip);
      // Then
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error.message).toContain(
        "was made by an older proofbox, or on another machine",
      );
      expect(yield* Ref.get(calls)).toEqual([]);
    }).pipe(runtimeConfig()),
  );

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
          executor: nodeExecutor,
          fs: nodeFs,
          api: fakeApi(yield* Ref.make<ReadonlyArray<string>>([])),
          login: Effect.die("unused"),
          openLink: () => Effect.succeed(link),
          forward: () => Effect.die("unused"),
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
          { name: "abc123def4567", region: "us" },
          new Date("1970-01-01T00:25:00Z"),
        );
        // Then
        const seen = yield* Ref.get(commands);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("docker exec -u root proofbox-abc123");
        expect(seen[0]).toContain("900");
        expect(yield* Ref.get(spawned)).toEqual([
          [
            "namespace",
            "namespace/extend-main",
            ["us", "abc123def4567", "900"],
          ],
          [
            "namespace",
            "namespace/extend-main",
            ["us", "abc123def4567", "120"],
          ],
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
    "create from a known Fingerprint runs the Snapshot image and keeps it and its Base 336h",
    () =>
      Effect.gen(function* () {
        // Given: the registry has the Snapshot and its Base
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const images: Array<string> = [];
        const pulls: Array<string> = [];
        const provider = makeProvider(
          calls,
          fakeDocker({ images, pulls }),
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
          pulls,
        }).toEqual({
          image: "nscr.io/tenant_x/proofbox-snapshot-linux:22d0cf15eb8e",
          snapshot: "22d0cf15eb8e",
          expiry: [
            "ensureImageExpiry proofbox-snapshot-linux@sha256:ab12 336",
            ...BASE_EXPIRY,
          ],
          pulls: [],
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
        expiry: BASE_EXPIRY,
        warnings: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
  });

  it.effect("a create that builds the Base keeps every Base digest 336h", () =>
    Effect.gen(function* () {
      // Given: no Base on the host or in the registry, so create builds it
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const pushed: Array<string> = [];
      const provider = makeProvider(
        calls,
        fakeDocker({ exists: false, pulled: false, pushed }),
      );
      // When
      yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      });
      // Then
      expect({
        pushed: pushed.map((tag) => BASE_IMAGE.test(tag)),
        expiry: (yield* Ref.get(calls)).filter((call) =>
          call.startsWith("ensureImageExpiry"),
        ),
      }).toEqual({ pushed: [true], expiry: BASE_EXPIRY });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("a create that pulls the Base keeps every Base digest 336h", () =>
    Effect.gen(function* () {
      // Given: the registry has the Base, the host does not
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const pulls: Array<string> = [];
      const pushed: Array<string> = [];
      const provider = makeProvider(
        calls,
        fakeDocker({ exists: false, pulls, pushed }),
      );
      // When
      yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      });
      // Then
      expect({
        pulled: pulls.map((tag) => BASE_IMAGE.test(tag)),
        pushed,
        expiry: (yield* Ref.get(calls)).filter((call) =>
          call.startsWith("ensureImageExpiry"),
        ),
      }).toEqual({ pulled: [true], pushed: [], expiry: BASE_EXPIRY });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a create from a Snapshot skips the Base expiry when the registry has no Base",
    () => {
      const warnings: Array<string> = [];
      return Effect.gen(function* () {
        // Given: the registry has the Snapshot but not its Base
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(
          calls,
          fakeDocker({}),
          snapshotRun({
            base: {
              exitCode: 1,
              stdout: "",
              stderr:
                "ERROR: nscr.io/tenant_x/proofbox-base-linux:0123456789ab: not found\n",
            },
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
          expiry: (yield* Ref.get(calls)).filter((call) =>
            call.startsWith("ensureImageExpiry"),
          ),
          warnings,
        }).toEqual({
          expiry: ["ensureImageExpiry proofbox-snapshot-linux@sha256:ab12 336"],
          warnings: [],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
    },
  );

  it.effect(
    "a failed Base expiry call warns and the Sandbox still starts",
    () => {
      const warnings: Array<string> = [];
      return Effect.gen(function* () {
        // Given: a token that cannot update registry images
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          expiryError: () =>
            new TokenPermissionError({
              provider: "namespace",
              call: "ContainerRegistryService.UpdateImageLifetime",
              need: "update registry images",
            }),
        });
        // When
        const info = yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        });
        // Then
        expect({ name: info.name, warnings }).toEqual({
          name: "abc123def4567",
          warnings: [
            "could not set the Base image expiry (This Namespace token lacks permission for ContainerRegistryService.UpdateImageLifetime. Use a token that can update registry images.)",
          ],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
    },
  );

  it.effect(
    "a failed expiry call on one Base digest still keeps the other digests",
    () => {
      const warnings: Array<string> = [];
      return Effect.gen(function* () {
        // Given: the registry refuses the index once
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          expiryError: (image) =>
            image === "proofbox-base-linux@sha256:ba5e"
              ? new ProviderUnavailableError({
                  provider: "namespace",
                  reason: "the Registry did not answer",
                })
              : undefined,
        });
        // When
        yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        });
        // Then
        expect({
          expiry: (yield* Ref.get(calls)).filter((call) =>
            call.startsWith("ensureImageExpiry"),
          ),
          warnings,
        }).toEqual({
          expiry: BASE_EXPIRY.slice(1),
          warnings: [
            "could not set the Base image expiry (the Registry did not answer)",
          ],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers(warnings)));
    },
  );

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
        yield* snapshots.save(
          { name: "abc123def4567", region: "us" },
          "22d0cf15eb8e",
        );
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
        snapshots.save({ name: "abc123def4567", region: "us" }, "22d0cf15eb8e"),
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
      expect({ name: info.name, region: info.region }).toEqual({
        name: "abc123def4567",
        region: "us",
      });
      expect((yield* Ref.get(calls)).slice(0, 2)).toEqual([
        "create us",
        "wait us abc123def4567",
      ]);
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("create marks a Linux host once its Sandbox is made", () =>
    Effect.gen(function* () {
      // Given: a link that keeps every command it runs
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const ran: Array<string> = [];
      const provider = makeProvider(calls, fakeDocker({}), (commandLine) => {
        ran.push(commandLine);
        return tenantRun(commandLine);
      });
      // When
      yield* provider.create({
        os: "linux",
        idle: Duration.minutes(15),
        maxLife: Duration.hours(3),
      });
      // Then: the last command on the host is the mark
      expect(ran.at(-1)).toBe('touch "$HOME/.proofbox-made"');
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
      expect({ name: info.name, region: info.region }).toEqual({
        name: "abc123def4567",
        region: "eu",
      });
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
        const outcome = yield* provider.delete({
          name: "abc123def4567",
          region: "us",
        });
        // Then: us was asked, never eu
        expect(outcome).toBe("deleted");
        expect(yield* Ref.get(calls)).toEqual([
          "list us",
          "list us",
          "destroy us abc123def4567",
        ]);
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  // Live clock: the retry's 5 s pace has to actually elapse.
  it.live(
    "a create refused for the plan limit tries again while the quota frees",
    () =>
      Effect.gen(function* () {
        // Given: a destroy frees quota a moment after it returns, so the
        // first create can still land on a full-looking account
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          createError: (n) =>
            n === 1
              ? new ProviderLimitError({
                  provider: "namespace",
                  limit: "want 4 vCPU 7 GB RAM; used all of 6 vCPU 14 GB RAM",
                })
              : undefined,
        });
        // When
        const info = yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        });
        // Then
        expect({ name: info.name, region: info.region }).toEqual({
          name: "abc123def4567",
          region: "us",
        });
        expect((yield* Ref.get(calls)).slice(0, 3)).toEqual([
          "create us",
          "create us",
          "wait us abc123def4567",
        ]);
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "list asks every known region and names each Sandbox with its region",
    () =>
      Effect.gen(function* () {
        // Given: one Linux Sandbox in us and one in eu
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), listRun, {
          instances: [
            {
              id: "abc123def4567",
              labels: { "proofbox.os": "linux" },
              region: "us",
            },
            {
              id: "eu0000000000a",
              labels: { "proofbox.os": "linux" },
              region: "eu",
            },
          ],
        });
        // When
        const listed = yield* provider.list;
        // Then: each Sandbox's name and region
        expect(
          listed.infos.map((info) => ({
            name: info.name,
            region: info.region,
          })),
        ).toEqual([
          { name: "abc123def4567", region: "us" },
          { name: "eu0000000000a", region: "eu" },
        ]);
        expect(listed.unreached).toEqual([]);
        expect([...(yield* Ref.get(calls))].sort()).toEqual([
          "list eu",
          "list eu",
          "list us",
          "list us",
        ]);
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "list keeps the regions that answer and names the one that did not",
    () =>
      Effect.gen(function* () {
        // Given: eu cannot be reached
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), listRun, {
          instances: [
            {
              id: "abc123def4567",
              labels: { "proofbox.os": "linux" },
              region: "us",
            },
          ],
          listError: (region) =>
            region === "eu"
              ? new ProviderUnavailableError({
                  provider: "namespace",
                  reason:
                    "Could not reach Namespace. Check your network and try again.",
                })
              : undefined,
        });
        // When
        const listed = yield* provider.list;
        // Then
        expect(
          listed.infos.map((info) => ({
            name: info.name,
            region: info.region,
          })),
        ).toEqual([{ name: "abc123def4567", region: "us" }]);
        expect(listed.unreached).toEqual([
          {
            where: "Namespace region eu",
            reason:
              "Could not reach Namespace. Check your network and try again.",
          },
        ]);
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list with every region down fails with the Namespace error", () =>
    Effect.gen(function* () {
      // Given: neither region answers
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), listRun, {
        listError: () =>
          new ProviderUnavailableError({
            provider: "namespace",
            reason:
              "Could not reach Namespace. Check your network and try again.",
          }),
      });
      // When
      const error = yield* Effect.flip(provider.list);
      // Then
      expect({
        tag: error._tag,
        message: error.message,
      }).toEqual({
        tag: "ProviderUnavailableError",
        message: "Could not reach Namespace. Check your network and try again.",
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list with no Namespace login lists nothing", () =>
    Effect.gen(function* () {
      // Given: the login itself is missing
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), listRun, {
        listError: () => new NotLoggedInError({ provider: "namespace" }),
      });
      // When
      const listed = yield* provider.list;
      // Then: no api call was ever made
      expect(listed).toEqual({ infos: [], unreached: [], unfinished: [] });
      expect(yield* Ref.get(calls)).toEqual([]);
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list names a Mac host with no Sandbox state as unfinished", () =>
    Effect.gen(function* () {
      // Given: a Mac host whose state file was never written
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "us:mac000000000a",
      }).pipe(Effect.provide(NodeContext.layer));
      writeFileSync(
        paths.sshdKnownHosts,
        "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSshdHostKey\n",
      );
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        () =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: "cat: /var/proofbox/labels.json: No such file or directory",
          }),
        { instances: [UNFINISHED_MAC] },
      );
      // When
      const listed = yield* provider.list;
      // Then
      expect({ infos: listed.infos, unfinished: listed.unfinished }).toEqual({
        infos: [],
        unfinished: [
          {
            name: "mac000000000a",
            region: "us",
            os: "macos",
            createdAt: new Date("2026-10-01T07:49:00Z"),
          },
        ],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list names a Mac with no pinned sshd host key as unreached", () =>
    Effect.gen(function* () {
      // Given
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        (line) =>
          Ref.update(runs, (all) => [...all, line]).pipe(
            Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
          ),
        { instances: [UNFINISHED_MAC] },
      );
      // When
      const listed = yield* provider.list;
      // Then
      expect({
        infos: listed.infos,
        unreached: listed.unreached,
        runs: yield* Ref.get(runs),
      }).toEqual({
        infos: [],
        unreached: [
          {
            where: "Namespace region us",
            reason:
              "Sandbox ns:us:mac000000000a was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ns:us:mac000000000a",
          },
        ],
        runs: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list names a Linux host with no container as unfinished", () =>
    Effect.gen(function* () {
      // Given: a Linux host whose Sandbox container was never made
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        () =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: "Error: No such object: proofbox-lin000",
          }),
        { instances: [UNFINISHED_LINUX] },
      );
      // When
      const listed = yield* provider.list;
      // Then
      expect({ infos: listed.infos, unfinished: listed.unfinished }).toEqual({
        infos: [],
        unfinished: [
          {
            name: "lin000000000a",
            region: "us",
            os: "linux",
            createdAt: new Date("2026-10-01T07:49:00Z"),
          },
        ],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list drops a Linux host whose container stopped", () =>
    Effect.gen(function* () {
      // Given: the container stopped itself at its Deadline
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        () =>
          Effect.succeed(
            done(`${JSON.stringify({ "proofbox.name": "lin000" })}|false\n0\n`),
          ),
        { instances: [UNFINISHED_LINUX] },
      );
      // When
      const listed = yield* provider.list;
      // Then
      expect({ infos: listed.infos, unfinished: listed.unfinished }).toEqual({
        infos: [],
        unfinished: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect("list drops a Linux host whose Sandbox expired", () =>
    Effect.gen(function* () {
      // Given: Docker removed the container at its Deadline; the host
      // still has the mark create left
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        fakeDocker({}),
        (commandLine) =>
          Effect.succeed(
            commandLine.includes(".proofbox-made")
              ? done()
              : {
                  exitCode: 1,
                  stdout: "",
                  stderr: "Error: No such object: proofbox-lin000",
                },
          ),
        { instances: [UNFINISHED_LINUX] },
      );
      // When
      const listed = yield* provider.list;
      // Then
      expect({ infos: listed.infos, unfinished: listed.unfinished }).toEqual({
        infos: [],
        unfinished: [],
      });
    }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "list names a host Namespace is still starting without reading it",
    () =>
      Effect.gen(function* () {
        // Given: Namespace still makes the Mac host; the link counts reads
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        let reads = 0;
        const provider = makeProvider(
          calls,
          fakeDocker({}),
          () =>
            Effect.sync(() => {
              reads += 1;
              return done();
            }),
          { instances: [{ ...UNFINISHED_MAC, starting: true }] },
        );
        // When
        const listed = yield* provider.list;
        // Then
        expect({ unfinished: listed.unfinished, reads }).toEqual({
          unfinished: [
            {
              name: "mac000000000a",
              region: "us",
              os: "macos",
              createdAt: new Date("2026-10-01T07:49:00Z"),
            },
          ],
          reads: 0,
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );
});

// Hosts a create started and never finished, as ListInstances lists them.
const UNFINISHED_MAC = {
  id: "mac000000000a",
  labels: { "proofbox.os": "macos" },
  region: "us",
  createdAt: new Date("2026-10-01T07:49:00Z"),
};
const UNFINISHED_LINUX = {
  id: "lin000000000a",
  labels: { "proofbox.os": "linux" },
  region: "us",
  createdAt: new Date("2026-10-01T07:49:00Z"),
};

const NS_ID = "ns:us:abc123def4567";

const stderrEvent = (text: string): ExecEvent => ({
  _tag: "Stderr",
  bytes: new TextEncoder().encode(text),
});

// A Linux Namespace Sandbox (idle 15m) with its Keeper in this process.
// The link and its Docker count each call; `execStream` answers a command
// with the checks' start mark, a trailer, and exit 0, unless the test
// gives its own answer, which can read the API calls so far. Each API call
// lands in `calls`, an `extend` with its seconds, and each detached spawn
// in `spawned`.
const warmNamespace = (
  answer: (
    calls: Ref.Ref<ReadonlyArray<string>>,
  ) => Stream.Stream<ExecEvent, ProviderUnavailableError> = () =>
    Stream.fromIterable<ExecEvent>([
      stderrEvent(CHECKS_START),
      stderrEvent(checksTrailer(0, 0)),
      { _tag: "Exit", code: 0 },
    ]),
) =>
  Effect.gen(function* () {
    const counts = { run: 0, stream: 0, execStream: 0, execText: 0 };
    const runs: Array<string> = [];
    const spawned: Array<string> = [];
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const api = fakeApi(calls);
    const base = fakeDocker({});
    const docker: DockerClient = {
      ...base,
      execStream: () => {
        counts.execStream += 1;
        return answer(calls);
      },
      execText: (container, user, argv) => {
        counts.execText += 1;
        return base.execText(container, user, argv);
      },
    };
    const provider = makeNamespaceProvider({
      executor: nodeExecutor,
      fs: nodeFs,
      api: {
        ...api,
        extend: (region, instanceId, seconds) =>
          Ref.update(calls, (all) => [
            ...all,
            `extend ${region} ${instanceId} ${seconds}`,
          ]),
      },
      login: Effect.succeed({
        token: Redacted.make("token"),
        region: Option.none(),
      }),
      openLink: () =>
        Effect.succeed<Link>({
          ssh: [],
          stream: () => {
            counts.stream += 1;
            return Stream.empty;
          },
          run: (commandLine) => {
            counts.run += 1;
            runs.push(commandLine);
            return commandLine.includes("docker inspect")
              ? Effect.succeed(
                  done(
                    `${JSON.stringify({
                      "proofbox.name": "abc123",
                      "proofbox.os": "linux",
                      "proofbox.created-at": "1970-01-01T00:00:00Z",
                      "proofbox.idle-seconds": "900",
                      "proofbox.max-life-at": "2099-01-01T00:00:00Z",
                    })}|true\n900\n`,
                  ),
                )
              : Effect.succeed(done());
          },
        }),
      forward: () => Effect.die("unused"),
      dockerFor: () => docker,
      spawnDetached: (_provider, rel, args) =>
        Effect.sync(() => {
          spawned.push(`${rel} ${args.join(" ")}`);
        }),
    });
    // The Max-life cap the host push reads, as create writes it.
    const paths = yield* keeperPaths({
      provider: "ns",
      name: "us:abc123def4567",
    }).pipe(Effect.provide(NodeContext.layer));
    writeFileSync(paths.maxLife, "4102444800\n");
    const layers = yield* startKeeper(NS_ID, provider);
    counts.run = 0;
    counts.stream = 0;
    counts.execStream = 0;
    counts.execText = 0;
    runs.length = 0;
    return { counts, runs, spawned, calls, layers };
  });

describe("Namespace Provider through the Keeper", () => {
  it.scoped("a warm exec through the Keeper makes one call over the link", () =>
    Effect.gen(function* () {
      // Given
      const ns = yield* warmNamespace();
      // When
      const code = yield* execInSandbox(NS_ID, ["true"]).pipe(
        Effect.zipRight(Effect.flatMap(CliOutput, (output) => output.exitCode)),
        Effect.provide(ns.layers),
      );
      // Then
      expect(code).toBe(0);
      expect(ns.counts).toEqual({
        run: 0,
        stream: 0,
        execStream: 1,
        execText: 0,
      });
      expect(ns.spawned).toEqual([]);
      const pushed = Effect.map(Ref.get(ns.calls), (all) =>
        all.includes("extend us abc123def4567 900"),
      );
      yield* eventually(pushed);
      expect(yield* pushed).toBe(true);
    }).pipe(runtimeConfig()),
  );

  it.scoped(
    "a command through the Keeper pushes the host's life once before and once after it",
    () =>
      Effect.gen(function* () {
        // Given: the command ends only once the push before it has landed;
        // a newer push cancels one that has not
        const pushes = (calls: Ref.Ref<ReadonlyArray<string>>) =>
          Effect.map(Ref.get(calls), (all) =>
            all.filter((line) => line === "extend us abc123def4567 900"),
          );
        const ns = yield* warmNamespace((calls) =>
          Stream.concat(
            Stream.execute(
              eventually(
                Effect.map(pushes(calls), (lines) => lines.length >= 1),
              ),
            ),
            Stream.fromIterable<ExecEvent>([
              stderrEvent(CHECKS_START),
              stderrEvent(checksTrailer(0, 0)),
              { _tag: "Exit", code: 0 },
            ]),
          ),
        );
        // When
        yield* execInSandbox(NS_ID, ["true"]).pipe(Effect.provide(ns.layers));
        yield* eventually(
          Effect.map(pushes(ns.calls), (lines) => lines.length >= 2),
        );
        // Then
        expect(yield* pushes(ns.calls)).toEqual([
          "extend us abc123def4567 900",
          "extend us abc123def4567 900",
        ]);
      }).pipe(runtimeConfig()),
  );

  it.scoped("the Keeper and its gone-watch start no extend-main", () =>
    Effect.gen(function* () {
      // Given
      const ns = yield* warmNamespace();
      yield* execInSandbox(NS_ID, ["true"]).pipe(Effect.provide(ns.layers));
      const before = ns.runs.length;
      // When
      yield* TestClock.adjust("2 seconds");
      yield* eventually(Effect.sync(() => ns.runs.length > before));
      // Then
      expect(ns.spawned).toEqual([]);
      const watched = ns.runs.slice(before);
      expect(watched).toHaveLength(1);
      expect(watched[0]).toContain("docker inspect");
    }).pipe(runtimeConfig()),
  );

  it.scoped("a link that drops mid-command ends with the link message", () =>
    Effect.gen(function* () {
      // Given
      const ns = yield* warmNamespace(() =>
        Stream.fail(
          new ProviderUnavailableError({
            provider: "namespace",
            reason:
              "lost the link to the Namespace host: the ssh link dropped mid-command",
          }),
        ),
      );
      // When
      const error = yield* execInSandbox(NS_ID, ["true"]).pipe(
        Effect.provide(ns.layers),
        Effect.flip,
      );
      // Then
      expect(error.message).toBe(
        "Provider namespace failed: lost the link to the Namespace host: the ssh link dropped mid-command",
      );
    }).pipe(runtimeConfig()),
  );

  it.scoped(
    "a failed Deadline write ends the command with the write's error",
    () =>
      Effect.gen(function* () {
        // Given
        const ns = yield* warmNamespace(() =>
          Stream.fromIterable<ExecEvent>([
            stderrEvent(CHECKS_START),
            stderrEvent(pushFailedTrailer("mv: Read-only file system")),
            { _tag: "Exit", code: 1 },
          ]),
        );
        // When
        const error = yield* execInSandbox(NS_ID, ["true"]).pipe(
          Effect.provide(ns.layers),
          Effect.flip,
        );
        // Then
        expect(error.message).toBe(
          "Provider namespace failed: could not write the Deadline: mv: Read-only file system",
        );
      }).pipe(runtimeConfig()),
  );
});
