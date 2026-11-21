import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Cause,
  Chunk,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Stream,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { CHECKS_START } from "../src/command-checks.ts";
import { execInSandbox } from "../src/commands/exec.ts";
import {
  type DockerClient,
  makeDockerClient,
} from "../src/docker/docker-client.ts";
import {
  LinkDroppedError,
  NotLoggedInError,
  type ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenPermissionError,
} from "../src/errors.ts";
import { keeperPaths } from "../src/keeper/paths.ts";
import { linkDockerHost } from "../src/namespace/link-docker.ts";
import { type LinuxHost, makeLinuxHost } from "../src/namespace/linux-host.ts";
import type {
  ApiError,
  ApiLoginError,
  InstanceListed,
  NamespaceApi,
} from "../src/namespace/namespace-api.ts";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type {
  Link,
  LinkRoute,
  OpenLink,
  SshForward,
} from "../src/namespace/ssh-link.ts";
import { Progress } from "../src/progress.ts";
import type { ExecEvent } from "../src/provider.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";
import { checksTrailer, pushFailedTrailer } from "./support/checks.ts";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { nodeExecutor } from "./support/executor.ts";
import { startFakeNamespace, TENANT_1 } from "./support/fake-namespace-api.ts";
import { eventually, startKeeper } from "./support/keeper.ts";
import { unusedHost } from "./support/namespace-hosts.ts";
import { nodeFs } from "./support/node-fs.ts";
import { CapturedOutput, testOutput } from "./support/output.ts";

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
    // An error every `destroy` fails with, after it is recorded.
    readonly destroyError?: ApiError;
    // Whether the nth `destroy` (1-based) never ends, after it is recorded.
    readonly destroyStalls?: (n: number) => boolean;
    // How long `wait` takes on the Clock, after it is recorded.
    readonly waitTakes?: Duration.DurationInput;
  },
): NamespaceApi => {
  const note = (line: string) => Ref.update(calls, (all) => [...all, line]);
  let creates = 0;
  let destroyed = 0;
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
    wait: (region, instanceId) =>
      note(`wait ${region} ${instanceId}`).pipe(
        Effect.zipRight(
          options?.waitTakes === undefined
            ? Effect.void
            : Effect.sleep(options.waitTakes),
        ),
      ),
    destroy: (region, instanceId) =>
      Effect.suspend(() => {
        destroyed += 1;
        return note(`destroy ${region} ${instanceId}`).pipe(
          Effect.zipRight(
            options?.destroyStalls?.(destroyed) === true
              ? Effect.never
              : options?.destroyError === undefined
                ? Effect.void
                : Effect.fail(options.destroyError),
          ),
        );
      }),
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
  // Whether the host already has the image, and what a pull answers.
  readonly exists?: boolean;
  readonly pull?: (
    tag: string,
  ) => Effect.Effect<"pulled" | "missing", ProviderError>;
  // Collect the tag of every pull and every push.
  readonly pulls?: Array<string>;
  readonly pushed?: Array<string>;
  // What every `execStream` sends, such as the Live view's x11vnc start.
  readonly liveEvents?: ReadonlyArray<ExecEvent>;
  // What every `execStream` fails with in place of its events.
  readonly liveError?: SandboxGoneError | LinkDroppedError;
  // Collects the argv of every `execText`, joined by spaces.
  readonly execs?: Array<string>;
}): DockerClient<SandboxGoneError> => {
  let labels: Record<string, string> = {};
  const ok = (stdout = "") =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  return {
    serverArch: Effect.succeed("amd64"),
    imageExists: () => Effect.succeed(options.exists ?? true),
    pull: (tag) =>
      Effect.suspend(() => {
        options.pulls?.push(tag);
        return options.pull?.(tag) ?? Effect.succeed("pulled" as const);
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
      options.execs?.push(line);
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
    execStream: () =>
      options.liveError !== undefined
        ? Stream.fail(options.liveError)
        : options.liveEvents === undefined
          ? Stream.empty
          : Stream.fromIterable(options.liveEvents),
    inspect: () =>
      Effect.succeed(Option.some({ labels: { ...labels }, running: true })),
    listNames: Effect.succeed([]),
    remove: () => Effect.void,
  };
};

const liveLayers = (warnings?: Array<string>) =>
  Layer.mergeAll(
    testOutput,
    // A heartbeat-less Progress, like test/deadline.test.ts.
    Layer.succeed(
      Progress,
      new Progress({
        note: () => Effect.void,
        done: () => Effect.void,
        hint: () => Effect.void,
        step: (_label, effect) => effect,
        warn: (text) =>
          Effect.sync(() => {
            warnings?.push(text);
          }),
      }),
    ),
  );

// A fresh runtime folder; each `pinned` Sandbox (`<region>:<name>`) gets
// the sshd host key pin create would have written.
const runtimeConfig = (...pinned: ReadonlyArray<string>) => {
  const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
  for (const stem of pinned) {
    writeFileSync(
      join(runtime, `ns-${stem}.sshd-known-hosts`),
      "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSshdHostKey\n",
    );
  }
  return Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
  );
};

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

// The host key the sshd step prints, as a Linux host's sshd would.
const SSHD_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSshdHostKey\n";

const tenantRun = (commandLine: string) => {
  if (commandLine.includes("cat /etc/ssh/ssh_host_ed25519_key.pub")) {
    return Effect.succeed(done(SSHD_HOST_KEY));
  }
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
  if (commandLine.includes("/run/proofbox/deadline")) {
    return Effect.succeed(done("9999999999\n"));
  }
  if (commandLine.includes("'docker' 'inspect'")) {
    const short = /proofbox-([a-z0-9]+)/.exec(commandLine)?.[1] ?? "";
    return Effect.succeed(
      done(
        `${JSON.stringify({
          "proofbox.name": short,
          "proofbox.os": "linux",
          "proofbox.created-at": "2026-01-01T00:00:00Z",
          "proofbox.idle-seconds": "300",
          "proofbox.max-life-at": "2099-01-01T00:00:00Z",
        })}|true\n`,
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
      if (commandLine.includes("cat /etc/ssh/ssh_host_ed25519_key.pub")) {
        return done(SSHD_HOST_KEY);
      }
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

// Links that keep where each one went, `<owner> <to>[ <user>]`, and which
// route each command line took; `sshdDown` fails the sshd open as a dead
// sshd would.
const routedLinks = (run: Link["run"], sshdDown = false) => {
  const links: Array<string> = [];
  const routed: Array<readonly [LinkRoute["to"], string]> = [];
  const openLink: OpenLink = (_ref, _paths, owner, route) =>
    Effect.suspend(() => {
      links.push(
        `${owner} ${route.to}${route.to === "sshd" ? ` ${route.user}` : ""}`,
      );
      return route.to === "sshd" && sshdDown
        ? Effect.fail(
            new ProviderUnavailableError({
              provider: "namespace",
              reason:
                "Could not connect to Sandbox ns:us:abc123def4567 over SSH (ssh exited). Try again in a minute.",
            }),
          )
        : Effect.succeed<Link>({
            ssh: [],
            stream: () => Stream.empty,
            run: (line) =>
              Effect.suspend(() => {
                routed.push([route.to, line]);
                return run(line);
              }),
          });
    });
  return { openLink, links, routed };
};

const withRuntime = (runtime: string) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
  );

const BASE_IMAGE = /^nscr\.io\/tenant_x\/proofbox-base-linux:[0-9a-f]{12}$/;

// With no `docker`, the host's reads go through the real Docker client
// over the fake link, so `run` answers its docker commands.
const makeProvider = (
  calls: Ref.Ref<ReadonlyArray<string>>,
  docker: DockerClient<SandboxGoneError> | undefined,
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
    readonly destroyError?: ApiError;
    readonly destroyStalls?: (n: number) => boolean;
    readonly waitTakes?: Duration.DurationInput;
    readonly region?: string;
    readonly forward?: SshForward;
    readonly openLink?: OpenLink;
    readonly macos?: LinuxHost;
  },
) => {
  const api = fakeApi(calls, options);
  const openLink =
    options?.openLink ??
    (() =>
      Effect.succeed<Link>({
        ssh: [],
        stream: () => Stream.empty,
        run,
      }));
  return makeNamespaceProvider({
    executor: nodeExecutor,
    fs: nodeFs,
    api,
    login: Effect.succeed({
      token: Redacted.make("token"),
      region: Option.fromNullable(options?.region),
    }),
    openLink,
    forward: options?.forward ?? (() => Effect.die("unused")),
    spawnDetached: () => Effect.void,
    hosts: {
      linux: makeLinuxHost({
        api,
        fs: nodeFs,
        dockerFor: (link) =>
          docker ?? makeDockerClient(nodeExecutor, linkDockerHost(link)),
      }),
      macos: options?.macos ?? unusedHost("macos"),
    },
  });
};

// A fresh runtime folder, with the prep limit set when one is given.
const prepConfig = (prepTimeout?: string, createTimeout?: string) => {
  const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
  return Effect.withConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ["PROOFBOX_RUNTIME_DIR", runtime],
        ...(prepTimeout === undefined
          ? []
          : [["PROOFBOX_NS_PREPARE_TIMEOUT", prepTimeout] as const]),
        ...(createTimeout === undefined
          ? []
          : [["PROOFBOX_NS_CREATE_TIMEOUT", createTimeout] as const]),
      ]),
    ),
  );
};

// A link whose `docker pull` never ends, as a stalled registry pull would.
const stalledPullRun: Link["run"] = (commandLine) =>
  commandLine.startsWith("docker pull")
    ? Effect.never
    : snapshotRun({})(commandLine);

// A short real pause, so the create's file and ssh-keygen work can finish
// between two TestClock moves.
const realPause = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
);

// Moves the TestClock `step` at a time, with a real pause before each move,
// until the fiber ends or `rounds` moves are made.
const driveClock = <A, E>(
  fiber: Fiber.RuntimeFiber<A, E>,
  step: Duration.DurationInput,
  rounds: number,
) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round++) {
      yield* realPause;
      yield* TestClock.adjust(step);
      const exit = yield* Fiber.poll(fiber);
      if (Option.isSome(exit)) {
        return exit;
      }
    }
    yield* realPause;
    return yield* Fiber.poll(fiber);
  });

// The message of the error a fiber failed with, if it failed.
const failureMessage = <A, E extends { readonly message: string }>(
  exit: Option.Option<Exit.Exit<A, E>>,
) =>
  Option.getOrUndefined(
    Option.flatMap(exit, (done) =>
      Exit.isFailure(done)
        ? Option.map(Cause.failureOption(done.cause), (error) => error.message)
        : Option.none(),
    ),
  );

const destroys = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call === "destroy us abc123def4567");

const extendCalls = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call === "extend us abc123def4567").length;

describe("Namespace Provider", () => {
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

  it("list fails as unreachable when ListInstances never answers", async () => {
    // Given: ListInstances never answers; the request limit is 1s
    const ns = await startFakeNamespace((call) =>
      call.method === "ListInstances" ? "hang" : { json: {} },
    );
    const env = makeEnv();
    try {
      // When
      const result = await runCli(env, ["list"], {
        set: {
          PROOFBOX_NAMESPACE_TOKEN: TENANT_1,
          PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
          PROOFBOX_NS_REQUEST_TIMEOUT: "1s",
        },
      });
      // Then
      expect(result).toEqual({
        stdout: "",
        stderr:
          "Could not list Sandboxes in namespace: Could not reach Namespace. Check your network and try again.\nNo live Sandboxes\n",
        exitCode: 0,
      });
    } finally {
      cleanupEnvs();
      await ns.close();
    }
  });

  it.effect("a host with no local OS file and no OS label stays Linux", () =>
    Effect.gen(function* () {
      // Given: another host is a Mac; the requested host has no OS label.
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, undefined, listRun, {
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
    }).pipe(runtimeConfig("us:abc123def4567")),
  );

  it.effect("a local Linux OS file needs no API lookup", () =>
    Effect.gen(function* () {
      // Given: the local OS file takes precedence over the API label.
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, undefined, listRun, {
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
    }).pipe(runtimeConfig("us:abc123def4567")),
  );

  it.effect(
    "an unreadable local OS file fails with a Provider error that names the file",
    () =>
      Effect.gen(function* () {
        // Given: an OS file that is a folder, so reading it fails
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const ran: Array<string> = [];
        const recordingRun: Link["run"] = (commandLine) =>
          Effect.suspend(() => {
            ran.push(commandLine);
            return listRun(commandLine);
          });
        const provider = makeProvider(calls, fakeDocker({}), recordingRun, {
          instances: [
            { id: "abc123def4567", labels: { "proofbox.os": "macos" } },
          ],
        });
        const paths = yield* keeperPaths({
          provider: "ns",
          name: "us:abc123def4567",
        }).pipe(Effect.provide(NodeContext.layer));
        mkdirSync(paths.os);
        // When
        const error = yield* Effect.flip(
          provider.get({ name: "abc123def4567", region: "us" }),
        );
        // Then
        expect({
          message: error.message,
          calls: yield* Ref.get(calls),
          ran,
        }).toEqual({
          message: `Provider namespace failed: could not read the OS file ${paths.os}: EISDIR: illegal operation on a directory, read`,
          calls: [],
          ran: [],
        });
      }).pipe(runtimeConfig("us:abc123def4567")),
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
        const api = fakeApi(yield* Ref.make<ReadonlyArray<string>>([]));
        const dockerFor = (sandbox: Link) =>
          makeDockerClient(nodeExecutor, linkDockerHost(sandbox));
        const openLink = () => Effect.succeed(link);
        const provider = makeNamespaceProvider({
          executor: nodeExecutor,
          fs: nodeFs,
          api,
          login: Effect.die("unused"),
          openLink,
          forward: () => Effect.die("unused"),
          spawnDetached: (provider, rel, args) =>
            Ref.update(spawned, (all) => [
              ...all,
              [provider, rel, args] as const,
            ]),
          hosts: {
            linux: makeLinuxHost({ api, fs: nodeFs, dockerFor }),
            macos: unusedHost("macos"),
          },
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
        expect(seen[0]).toContain(
          "'docker' 'exec' '-u' 'root' 'proofbox-abc123'",
        );
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
      }).pipe(runtimeConfig("us:abc123def4567")),
  );

  it.effect(
    "a Linux Live view starts x11vnc in the container and forwards port 5900",
    () =>
      Effect.gen(function* () {
        // Given: x11vnc prints the settled password; the forward lands on 50124
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const paths = yield* keeperPaths({
          provider: "ns",
          name: "us:abc123def4567",
        }).pipe(Effect.provide(NodeContext.layer));
        writeFileSync(paths.os, "linux\n");
        const provider = makeProvider(
          calls,
          fakeDocker({
            liveEvents: [
              {
                _tag: "Stdout",
                bytes: new TextEncoder().encode("Pw4xQ9zT"),
              },
              { _tag: "Exit", code: 0 },
            ],
          }),
          tenantRun,
          {
            forward: (ref, port) =>
              Ref.update(calls, (all) => [
                ...all,
                `portForward ${ref.region}:${ref.name} ${port}`,
              ]).pipe(Effect.as({ port: 50124, gone: Effect.never })),
          },
        );
        const liveView = provider.liveView;
        // When
        const view = yield* liveView === undefined
          ? Effect.die("no liveView")
          : liveView({ name: "abc123def4567", region: "us" });
        // Then
        expect({
          address: view.address,
          password: view.password,
          forwarded: (yield* Ref.get(calls)).includes(
            "portForward us:abc123def4567 5900",
          ),
        }).toEqual({
          address: "127.0.0.1:50124",
          password: "Pw4xQ9zT",
          forwarded: true,
        });
      }).pipe(Effect.scoped, runtimeConfig("us:abc123def4567")),
  );

  for (const [name, liveError, expected] of [
    [
      "a Linux Live view whose link drops while it starts x11vnc fails link-lost",
      new LinkDroppedError({
        reason:
          "Could not connect to Sandbox ns:us:abc123def4567 over SSH (the ssh link dropped mid-command). Try again in a minute.",
      }),
      {
        _tag: "ProviderUnavailableError",
        message:
          "Could not connect to Sandbox ns:us:abc123def4567 over SSH (the ssh link dropped mid-command). Try again in a minute.",
      },
    ],
    [
      "a Linux Live view on a Sandbox deleted while it starts x11vnc fails gone",
      new SandboxGoneError({ id: "ns:us:abc123def4567" }),
      {
        _tag: "SandboxGoneError",
        message: "Sandbox ns:us:abc123def4567 is gone",
      },
    ],
  ] as const) {
    it.live(name, () =>
      Effect.gen(function* () {
        // Given
        const paths = yield* keeperPaths({
          provider: "ns",
          name: "us:abc123def4567",
        }).pipe(Effect.provide(NodeContext.layer));
        writeFileSync(paths.os, "linux\n");
        const provider = makeProvider(
          yield* Ref.make<ReadonlyArray<string>>([]),
          fakeDocker({ liveError }),
          tenantRun,
          {
            forward: () => Effect.succeed({ port: 50124, gone: Effect.never }),
          },
        );
        const liveView = provider.liveView;
        // When
        const error = yield* (
          liveView === undefined
            ? Effect.die("no liveView")
            : liveView({ name: "abc123def4567", region: "us" })
        ).pipe(Effect.scoped, Effect.flip);
        // Then
        expect({ _tag: error._tag, message: error.message }).toEqual(expected);
      }).pipe(runtimeConfig("us:abc123def4567")),
    );
  }

  it.effect("closing the last Linux Live view stops x11vnc", () =>
    Effect.gen(function* () {
      // Given: x11vnc prints the settled password; each docker exec is kept
      const execs: Array<string> = [];
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "us:abc123def4567",
      }).pipe(Effect.provide(NodeContext.layer));
      writeFileSync(paths.os, "linux\n");
      const provider = makeProvider(
        yield* Ref.make<ReadonlyArray<string>>([]),
        fakeDocker({
          liveEvents: [
            { _tag: "Stdout", bytes: new TextEncoder().encode("Pw4xQ9zT") },
            { _tag: "Exit", code: 0 },
          ],
          execs,
        }),
        tenantRun,
        {
          forward: () => Effect.succeed({ port: 50124, gone: Effect.never }),
        },
      );
      const liveView = provider.liveView;
      // When: a Live view opens and its scope closes
      yield* (
        liveView === undefined
          ? Effect.die("no liveView")
          : liveView({ name: "abc123def4567", region: "us" })
      ).pipe(Effect.scoped);
      // Then
      expect(execs.at(-1)).toContain("pkill -x x11vnc");
    }).pipe(runtimeConfig("us:abc123def4567")),
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
        fakeDocker({
          exists: false,
          pull: () => Effect.succeed("missing" as const),
          pushed,
        }),
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
    "a Linux create from a Snapshot prints a line for each prep step",
    () =>
      Effect.gen(function* () {
        // Given: every command on the link succeeds
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), snapshotRun({}));
        // When
        yield* provider
          .create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
            snapshot: "22d0cf15eb8e",
          })
          .pipe(Effect.provide(Progress.Default));
        // Then
        const output = yield* CapturedOutput;
        const err = Chunk.toReadonlyArray(yield* Ref.get(output.err)).join("");
        expect(err).toBe(
          "proofbox: installing sshd\nproofbox: starting sshd\nproofbox: reading the Namespace tenant\nproofbox: pulling the Snapshot\nproofbox: setting the Snapshot expiry\nproofbox: creating docker Sandbox\nproofbox: setting the Base image expiry\nproofbox: checking the Namespace token is out of reach\n",
        );
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a create whose host takes longer than the Max life fails and deletes the host",
    () =>
      Effect.gen(function* () {
        // Given: Namespace takes 40 s to make the host; the Max life is 30 s
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          waitTakes: "40 seconds",
        });
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "linux",
            idle: Duration.minutes(10),
            maxLife: Duration.seconds(30),
          }),
        );
        const exit = yield* driveClock(fiber, "10 seconds", 10);
        // Then
        expect({
          message: failureMessage(exit),
          destroys: destroys(yield* Ref.get(calls)),
        }).toEqual({
          message:
            "Provider namespace failed: making the host took the whole Max life; try a larger --max-life",
          destroys: ["destroy us abc123def4567"],
        });
      }).pipe(prepConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a create whose host is not made in time names the wait in minutes and seconds",
    () =>
      Effect.gen(function* () {
        // Given: Namespace takes 5 min to make the host; the create limit is 90s
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          waitTakes: "5 minutes",
        });
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "linux",
            idle: Duration.minutes(10),
            maxLife: Duration.hours(3),
          }),
        );
        const exit = yield* driveClock(fiber, "10 seconds", 12);
        // Then
        expect(failureMessage(exit)).toBe(
          "Namespace did not make the host in 1 min 30 s; deleted any half-made host. Try again",
        );
      }).pipe(prepConfig(undefined, "90s"), Effect.provide(liveLayers())),
  );

  it.effect(
    "a Linux create whose docker pull never ends stops at the prep limit and deletes the host",
    () =>
      Effect.gen(function* () {
        // Given: a link whose `docker pull` never ends; the prep limit is 1s
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), stalledPullRun);
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
            snapshot: "22d0cf15eb8e",
          }),
        );
        const exit = yield* driveClock(fiber, "1 second", 40);
        // Then
        expect({
          message: failureMessage(exit),
          destroys: destroys(yield* Ref.get(calls)),
        }).toEqual({
          message:
            "Namespace did not prepare the host in 1 s (stuck at: pulling the Snapshot); deleted the host. Try again",
          destroys: ["destroy us abc123def4567"],
        });
      }).pipe(prepConfig("1s"), Effect.provide(liveLayers())),
  );

  it.effect(
    "a macOS create whose prep never ends stops at the prep limit and deletes the host",
    () =>
      Effect.gen(function* () {
        // Given: a Mac host whose prepare never ends; the prep limit is 1s
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const stuck = yield* Deferred.make<void>();
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          macos: {
            ...unusedHost("macos"),
            sshd: {
              start: "cat /etc/ssh/ssh_host_ed25519_key.pub",
              user: "runner",
            },
            prepare: () =>
              Effect.flatMap(Progress, (progress) =>
                progress.step(
                  "installing the Tool bundle",
                  Deferred.succeed(stuck, undefined).pipe(
                    Effect.zipRight(Effect.never),
                  ),
                ),
              ),
          },
        });
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "macos",
            idle: Duration.minutes(10),
            maxLife: Duration.hours(3),
          }),
        );
        // The clock moves only once prepare is stuck: the sshd step before
        // it reads and writes real files, which can outlast a 1 s step.
        yield* Deferred.await(stuck);
        const exit = yield* driveClock(fiber, "1 second", 40);
        // Then
        expect({
          message: failureMessage(exit),
          destroys: destroys(yield* Ref.get(calls)),
        }).toEqual({
          message:
            "Namespace did not prepare the host in 1 s (stuck at: installing the Tool bundle); deleted the host. Try again",
          destroys: ["destroy us abc123def4567"],
        });
      }).pipe(prepConfig("1s"), Effect.provide(liveLayers())),
  );

  it.effect(
    "a prep timeout deletes the host without waiting for cleanup on it",
    () =>
      Effect.gen(function* () {
        // Given: a Mac host whose prep never ends, and whose cleanup on an
        // interrupt never ends either, as a `docker rm -f` on a stuck
        // Docker would; the prep limit is 1s
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const stuck = yield* Deferred.make<void>();
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          macos: {
            ...unusedHost("macos"),
            sshd: {
              start: "cat /etc/ssh/ssh_host_ed25519_key.pub",
              user: "runner",
            },
            prepare: () =>
              Effect.flatMap(Progress, (progress) =>
                progress.step(
                  "creating docker Sandbox",
                  Deferred.succeed(stuck, undefined).pipe(
                    Effect.zipRight(Effect.never),
                    Effect.onInterrupt(() => Effect.never),
                  ),
                ),
              ),
          },
        });
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "macos",
            idle: Duration.minutes(10),
            maxLife: Duration.hours(3),
          }),
        );
        // The clock moves only once prepare is stuck: the sshd step before
        // it reads and writes real files, which can outlast a 1 s step.
        yield* Deferred.await(stuck);
        const exit = yield* driveClock(fiber, "1 second", 40);
        // Then
        expect({
          message: failureMessage(exit),
          destroys: destroys(yield* Ref.get(calls)),
        }).toEqual({
          message:
            "Namespace did not prepare the host in 1 s (stuck at: creating docker Sandbox); deleted the host. Try again",
          destroys: ["destroy us abc123def4567"],
        });
      }).pipe(prepConfig("1s"), Effect.provide(liveLayers())),
  );

  it.effect(
    "Ctrl-C during the prep timeout's delete still deletes the host",
    () =>
      Effect.gen(function* () {
        // Given: a stalled `docker pull`, and a first delete that never ends
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), stalledPullRun, {
          destroyStalls: (n) => n === 1,
        });
        const fiber = yield* Effect.fork(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
            snapshot: "22d0cf15eb8e",
          }),
        );
        for (let round = 0; round < 40; round++) {
          yield* realPause;
          yield* TestClock.adjust("1 second");
          if (destroys(yield* Ref.get(calls)).length > 0) {
            break;
          }
        }
        // When: Ctrl-C while that first delete runs
        yield* Fiber.interrupt(fiber);
        // Then: cleanup sends the delete again
        expect(destroys(yield* Ref.get(calls))).toEqual([
          "destroy us abc123def4567",
          "destroy us abc123def4567",
        ]);
      }).pipe(prepConfig("1s"), Effect.provide(liveLayers())),
  );

  it.effect("a create stopped by the prep limit extends the host no more", () =>
    Effect.gen(function* () {
      // Given: a link whose `docker pull` never ends; the prep limit is 1s
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), stalledPullRun);
      const fiber = yield* Effect.fork(
        provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        }),
      );
      const exit = yield* driveClock(fiber, "1 second", 40);
      const atEnd = extendCalls(yield* Ref.get(calls));
      // When
      yield* TestClock.adjust("2 minutes");
      yield* realPause;
      // Then
      expect({
        ended: Option.isSome(exit),
        extends: extendCalls(yield* Ref.get(calls)),
      }).toEqual({ ended: true, extends: atEnd });
    }).pipe(prepConfig("1s"), Effect.provide(liveLayers())),
  );

  it.effect("with no prep setting a stalled create stops at 15 minutes", () =>
    Effect.gen(function* () {
      // Given: a link whose `docker pull` never ends; no prep setting
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), stalledPullRun);
      // When
      const fiber = yield* Effect.fork(
        provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
          snapshot: "22d0cf15eb8e",
        }),
      );
      const at14 = yield* driveClock(fiber, "15 seconds", 56);
      const at15 = yield* driveClock(fiber, "15 seconds", 5);
      // Then
      expect({
        at14: Option.isSome(at14),
        at15: failureMessage(at15),
      }).toEqual({
        at14: false,
        at15: "Namespace did not prepare the host in 15 min (stuck at: pulling the Snapshot); deleted the host. Try again",
      });
    }).pipe(prepConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a prep timeout whose delete fails says the host may be left",
    () => {
      const warnings: Array<string> = [];
      return Effect.gen(function* () {
        // Given: a stalled `docker pull`, and every delete fails as unreachable
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, fakeDocker({}), stalledPullRun, {
          destroyError: new ProviderUnavailableError({
            provider: "namespace",
            reason:
              "Could not reach Namespace. Check your network and try again.",
          }),
        });
        // When
        const fiber = yield* Effect.fork(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
            snapshot: "22d0cf15eb8e",
          }),
        );
        const exit = yield* driveClock(fiber, "1 second", 40);
        // Then
        expect({
          warnings,
          message: failureMessage(exit),
          destroys: destroys(yield* Ref.get(calls)),
        }).toEqual({
          warnings: [
            "could not delete the host this create started; it may be left. Run: proofbox list",
          ],
          message:
            "Namespace did not prepare the host in 1 s (stuck at: pulling the Snapshot). Try again",
          destroys: ["destroy us abc123def4567"],
        });
      }).pipe(prepConfig("1s"), Effect.provide(liveLayers(warnings)));
    },
  );

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
      }).pipe(runtimeConfig("us:abc123def4567"), Effect.provide(liveLayers())),
  );

  it.effect(
    "a save whose Snapshot expiry call fails warns and still saves",
    () => {
      const warnings: Array<string> = [];
      return Effect.gen(function* () {
        // Given: the registry does not answer the Snapshot's expiry call
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, undefined, snapshotRun({}), {
          expiryError: (image) =>
            image === "proofbox-snapshot-linux@sha256:ab12"
              ? new ProviderUnavailableError({
                  provider: "namespace",
                  reason: "the Registry did not answer",
                })
              : undefined,
        });
        const snapshots = yield* Effect.fromNullable(provider.snapshots).pipe(
          Effect.orDie,
        );
        // When
        yield* snapshots.save(
          { name: "abc123def4567", region: "us" },
          "22d0cf15eb8e",
        );
        // Then
        expect(warnings).toEqual([
          "could not set the Snapshot expiry (the Registry did not answer)",
        ]);
      }).pipe(
        runtimeConfig("us:abc123def4567"),
        Effect.provide(liveLayers(warnings)),
      );
    },
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
    }).pipe(runtimeConfig("us:abc123def4567"), Effect.provide(liveLayers())),
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

  it.effect(
    "Linux create installs sshd over the gateway, then makes the Sandbox over sshd as root",
    () => {
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      return Effect.gen(function* () {
        // Given: links that keep their route and every line they run
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(tenantRun);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        yield* provider.create({
          os: "linux",
          idle: Duration.minutes(15),
          maxLife: Duration.hours(3),
        });
        // Then
        const pub = readFileSync(
          join(runtime, "ns-us:abc123def4567.key.pub"),
          "utf8",
        ).trim();
        const pin = join(runtime, "ns-us:abc123def4567.sshd-known-hosts");
        expect({
          links: route.links,
          install: route.routed[0],
          startOn: route.routed[1]?.[0],
          authorizes: route.routed[1]?.[1].includes(
            `printf '%s\\n' '${pub}' >> ~/.ssh/authorized_keys`,
          ),
          starts: route.routed[1]?.[1].includes(
            '/usr/sbin/sshd -o ListenAddress=127.0.0.1:22 -o PidFile=/run/proofbox-sshd.pid -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no -o "SetEnv=PATH=$PATH"',
          ),
          later: [...new Set(route.routed.slice(2).map(([to]) => to))],
          last: route.routed.at(-1)?.[1],
          pin: readFileSync(pin, "utf8"),
          mode: statSync(pin).mode & 0o777,
        }).toEqual({
          links: ["cli gateway", "cli sshd root"],
          install: ["gateway", "apk add -q openssh-server"],
          startOn: "gateway",
          authorizes: true,
          starts: true,
          later: ["sshd"],
          last: 'touch "$HOME/.proofbox-made"',
          pin: "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeSshdHostKey\n",
          mode: 0o600,
        });
      }).pipe(withRuntime(runtime), Effect.provide(liveLayers()));
    },
  );

  it.effect(
    "a Linux host whose sshd cannot be installed fails create and deletes the Sandbox",
    () =>
      Effect.gen(function* () {
        // Given: exit 1 on `apk add`
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(
          (line) =>
            line === "apk add -q openssh-server"
              ? Effect.succeed({
                  exitCode: 1,
                  stdout: "",
                  stderr:
                    "ERROR: unable to select packages:\n  openssh-server (no such package)\n",
                })
              : tenantRun(line),
          false,
        );
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        const error = yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect({
          message: error.message,
          destroyed: (yield* Ref.get(calls)).includes(
            "destroy us abc123def4567",
          ),
          links: route.links,
        }).toEqual({
          message:
            "Sandbox ns:us:abc123def4567 failed the sshd step (sshd cannot be installed); deleted the Sandbox",
          destroyed: true,
          links: ["cli gateway"],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a Linux host whose sshd cannot be started fails create and deletes the Sandbox",
    () =>
      Effect.gen(function* () {
        // Given: exit 255 from the sshd start
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(
          (line) =>
            line.includes("/usr/sbin/sshd")
              ? Effect.succeed({
                  exitCode: 255,
                  stdout: "",
                  stderr:
                    "Bind to port 22 on 127.0.0.1 failed: Address in use.\n",
                })
              : tenantRun(line),
          false,
        );
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        const error = yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect({
          message: error.message,
          destroyed: (yield* Ref.get(calls)).includes(
            "destroy us abc123def4567",
          ),
          links: route.links,
        }).toEqual({
          message:
            "Sandbox ns:us:abc123def4567 failed the sshd step (sshd cannot be started); deleted the Sandbox",
          destroyed: true,
          links: ["cli gateway"],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a Linux host whose sshd cannot be reached fails create and deletes the Sandbox",
    () =>
      Effect.gen(function* () {
        // Given: an sshd that does not answer
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(tenantRun, true);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        const error = yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect({
          message: error.message,
          destroyed: (yield* Ref.get(calls)).includes(
            "destroy us abc123def4567",
          ),
          links: route.links,
        }).toEqual({
          message:
            "Sandbox ns:us:abc123def4567 failed the sshd step (sshd cannot be reached); deleted the Sandbox",
          destroyed: true,
          links: ["cli gateway", "cli sshd root"],
        });
      }).pipe(runtimeConfig(), Effect.provide(liveLayers())),
  );

  it.effect(
    "a call on a Linux Sandbox with no pinned sshd host key says an older proofbox made it",
    () => {
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      writeFileSync(join(runtime, "ns-us:abc123def4567.os"), "linux");
      return Effect.gen(function* () {
        // Given: a Linux Sandbox this machine never pinned an sshd key for
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(tenantRun);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        const error = yield* Effect.flip(
          provider.get({ name: "abc123def4567", region: "us" }),
        );
        // Then
        expect({
          tag: error._tag,
          message: error.message,
          links: route.links,
        }).toEqual({
          tag: "ProviderUnavailableError",
          message:
            "Sandbox ns:us:abc123def4567 was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ns:us:abc123def4567",
          links: [],
        });
      }).pipe(withRuntime(runtime), Effect.provide(liveLayers()));
    },
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

  it.effect("delete removes every local file of the host", () => {
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    for (const suffix of [
      ".key",
      ".key.pub",
      ".max-life",
      ".deadline",
      ".os",
      ".ctl",
      ".sock",
      ".sshkey",
      ".sshtarget",
      ".known-hosts",
      ".sshd-known-hosts",
    ]) {
      writeFileSync(join(runtime, `ns-us:abc123def4567${suffix}`), "");
    }
    return Effect.gen(function* () {
      // Given: every local file a host can have
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
        instances: [
          { id: "abc123def4567", labels: { "proofbox.os": "linux" } },
        ],
      });
      // When: deleted twice, so the second finds the files gone
      yield* provider.delete({ name: "abc123def4567", region: "us" });
      yield* provider.delete({ name: "abc123def4567", region: "us" });
      // Then
      expect(
        readdirSync(runtime).filter((name) =>
          name.startsWith("ns-us:abc123def4567"),
        ),
      ).toEqual([]);
    }).pipe(withRuntime(runtime), Effect.provide(liveLayers()));
  });

  it.effect(
    "a create that fails after the host is stored leaves no local file of the host",
    () => {
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      return Effect.gen(function* () {
        // Given: an sshd that does not answer, after the host files are written
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const route = routedLinks(tenantRun, true);
        const provider = makeProvider(calls, fakeDocker({}), tenantRun, {
          openLink: route.openLink,
        });
        // When
        yield* Effect.flip(
          provider.create({
            os: "linux",
            idle: Duration.minutes(15),
            maxLife: Duration.hours(3),
          }),
        );
        // Then
        expect(
          readdirSync(runtime).filter((name) => name.startsWith("ns-")),
        ).toEqual([]);
      }).pipe(withRuntime(runtime), Effect.provide(liveLayers()));
    },
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
        const provider = makeProvider(calls, undefined, listRun, {
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
      }).pipe(
        runtimeConfig("us:abc123def4567", "eu:eu0000000000a"),
        Effect.provide(liveLayers()),
      ),
  );

  it.effect(
    "list keeps the regions that answer and names the one that did not",
    () =>
      Effect.gen(function* () {
        // Given: eu cannot be reached
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const provider = makeProvider(calls, undefined, listRun, {
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
      }).pipe(runtimeConfig("us:abc123def4567"), Effect.provide(liveLayers())),
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

  it.effect("list names a Linux host with no container as unfinished", () =>
    Effect.gen(function* () {
      // Given: a Linux host whose Sandbox container was never made
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        undefined,
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
    }).pipe(runtimeConfig("us:lin000000000a"), Effect.provide(liveLayers())),
  );

  it.effect("list drops a Linux host whose container stopped", () =>
    Effect.gen(function* () {
      // Given: the container stopped itself at its Deadline
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        undefined,
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

  it.effect("get on a Linux Sandbox gives its region and its Snapshot", () =>
    Effect.gen(function* () {
      // Given: a Linux Sandbox in us that started from a Snapshot
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        undefined,
        (commandLine) =>
          commandLine.includes("'docker' 'inspect'")
            ? Effect.succeed(
                done(
                  `${JSON.stringify({
                    "proofbox.name": "abc123",
                    "proofbox.os": "linux",
                    "proofbox.created-at": "2026-01-01T00:00:00Z",
                    "proofbox.idle-seconds": "300",
                    "proofbox.max-life-at": "2099-01-01T00:00:00Z",
                    "proofbox.snapshot": "5ea1f00d",
                  })}|true\n`,
                ),
              )
            : listRun(commandLine),
        {
          instances: [
            {
              id: "abc123def4567",
              labels: { "proofbox.os": "linux" },
              region: "us",
            },
          ],
        },
      );
      // When
      const info = yield* provider.get({ name: "abc123def4567", region: "us" });
      // Then
      expect({ region: info.region, snapshot: info.snapshot }).toEqual({
        region: "us",
        snapshot: "5ea1f00d",
      });
    }).pipe(runtimeConfig("us:abc123def4567"), Effect.provide(liveLayers())),
  );

  it.effect("list drops a Linux host whose Sandbox expired", () =>
    Effect.gen(function* () {
      // Given: Docker removed the container at its Deadline; the host
      // still has the mark create left
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const provider = makeProvider(
        calls,
        undefined,
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
});

// A host a create started and never finished, as ListInstances lists it.
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
    const dockerFor = (link: Link): DockerClient<SandboxGoneError> => {
      const real = makeDockerClient(nodeExecutor, linkDockerHost(link));
      return {
        ...real,
        execStream: () => {
          counts.execStream += 1;
          return answer(calls);
        },
        execText: (container, user, argv) => {
          counts.execText += 1;
          return real.execText(container, user, argv);
        },
      };
    };
    const openLink = () =>
      Effect.succeed<Link>({
        ssh: [],
        stream: () => {
          counts.stream += 1;
          return Stream.empty;
        },
        run: (commandLine) => {
          counts.run += 1;
          runs.push(commandLine);
          if (commandLine.includes("/run/proofbox/deadline")) {
            return Effect.succeed(done("900\n"));
          }
          return commandLine.includes("'docker' 'inspect'")
            ? Effect.succeed(
                done(
                  `${JSON.stringify({
                    "proofbox.name": "abc123",
                    "proofbox.os": "linux",
                    "proofbox.created-at": "1970-01-01T00:00:00Z",
                    "proofbox.idle-seconds": "900",
                    "proofbox.max-life-at": "2099-01-01T00:00:00Z",
                  })}|true\n`,
                ),
              )
            : Effect.succeed(done());
        },
      });
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
      openLink,
      forward: () => Effect.die("unused"),
      spawnDetached: (_provider, rel, args) =>
        Effect.sync(() => {
          spawned.push(`${rel} ${args.join(" ")}`);
        }),
      hosts: {
        linux: makeLinuxHost({
          api,
          fs: nodeFs,
          dockerFor,
        }),
        macos: unusedHost("macos"),
      },
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
    }).pipe(runtimeConfig("us:abc123def4567")),
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
      }).pipe(runtimeConfig("us:abc123def4567")),
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
      expect(watched).toHaveLength(2);
      expect(watched[0]).toContain("'docker' 'inspect'");
      expect(watched[1]).toContain("/run/proofbox/deadline");
    }).pipe(runtimeConfig("us:abc123def4567")),
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
    }).pipe(runtimeConfig("us:abc123def4567")),
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
      }).pipe(runtimeConfig("us:abc123def4567")),
  );
});
