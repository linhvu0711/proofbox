import { FileSystem } from "@effect/platform";
import { Clock, Duration, Effect, Option, Schema } from "effect";
import type { ChecksShell } from "../command-checks.ts";
import {
  deadlineSeconds,
  firstDeadline,
  nextDeadline,
  parseDeadline,
} from "../deadline.ts";
import {
  ProviderError,
  SandboxGoneError,
  ToolBundleHashError,
} from "../errors.ts";
import { Progress } from "../progress.ts";
import {
  type ExecOptions,
  Os,
  type Provider,
  SandboxInfo,
  type SandboxRef,
} from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import { formatSize, parseSize, type Size } from "../size.ts";
import { LINUX_TOOL_BUNDLE } from "../tool-bundle.ts";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
  ensureBaseImage,
  type ToolBundleFile,
  toolBundleArgs,
  toolBundleForArch,
} from "./base-image.ts";
import type { DockerClient } from "./docker-client.ts";

const Labels = Schema.Struct({
  "proofbox.name": Schema.String,
  "proofbox.os": Os,
  "proofbox.created-at": Schema.Date,
  "proofbox.idle-seconds": Schema.NumberFromString.pipe(
    Schema.int(),
    Schema.positive(),
  ),
  "proofbox.max-life-at": Schema.Date,
  "proofbox.base-version": Schema.optional(Schema.String),
  "proofbox.snapshot": Schema.optional(Schema.String),
  "proofbox.size": Schema.optional(Schema.String),
});

export interface ProviderBrand {
  readonly provider: string;
  readonly id: (name: string) => string;
}

// The checks around a command in a Linux container, run as root: the
// Deadline file `get` reads, the cgroup's OOM-kill count, and the command
// as `app` in `/home/app`, as `docker exec -u app` ran it.
export const LINUX_CHECKS: ChecksShell = {
  push: 'tmp=/run/proofbox/.deadline.$$; printf "%s\\n" "$d" > "$tmp" && mv "$tmp" /run/proofbox/deadline',
  kills:
    "{ cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control; } | sed -n 's/^oom_kill //p'",
  run: 'unset PWD OLDPWD; HOME=/home/app setpriv --reuid=app --regid=app --init-groups "$@"',
};

const DOCKER_BRAND: ProviderBrand = {
  provider: "docker",
  id: (name) => `docker:${name}`,
};

// Labels and the Deadline file are the whole persisted state; both the
// local Docker Provider and the Namespace Provider build SandboxInfo the
// same way from them.
export const sandboxInfoFromLabels = Effect.fn(
  "dockerProvider.sandboxInfoFromLabels",
)(function* (
  brand: ProviderBrand,
  name: string,
  rawLabels: unknown,
  deadline: Date,
  region?: string,
) {
  const fail = (reason: string) =>
    new ProviderError({ provider: brand.provider, reason });
  const gone = new SandboxGoneError({ id: brand.id(name) });
  const ownedBy = yield* Schema.decodeUnknown(
    Schema.Struct({ "proofbox.name": Schema.String }),
  )(rawLabels).pipe(Effect.option);
  if (Option.isNone(ownedBy) || ownedBy.value["proofbox.name"] !== name) {
    return yield* gone;
  }
  const labels = yield* Schema.decodeUnknown(Labels)(rawLabels).pipe(
    Effect.mapError((error) => fail(error.message)),
  );
  const sizeLabel = labels["proofbox.size"];
  const size =
    sizeLabel === undefined
      ? undefined
      : yield* parseSize(sizeLabel).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
  return new SandboxInfo({
    name,
    region,
    os: labels["proofbox.os"],
    createdAt: labels["proofbox.created-at"],
    idleSeconds: labels["proofbox.idle-seconds"],
    deadline,
    maxLifeAt: labels["proofbox.max-life-at"],
    base: labels["proofbox.base-version"],
    snapshot: labels["proofbox.snapshot"],
    size,
  });
});

const containerOf = (name: string) => `proofbox-${name}`;

const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

const failFor = (brand: ProviderBrand) => (reason: string) =>
  new ProviderError({ provider: brand.provider, reason });

// The Sandbox in its container, or none when Docker has no such container.
// A container that stops or goes between the inspect and the Deadline read
// is gone or missing rather than malformed.
export const readDockerSandbox = Effect.fn("dockerProvider.readDockerSandbox")(
  function* <E>(
    client: DockerClient<E>,
    brand: ProviderBrand,
    name: string,
    region?: string,
  ) {
    const gone = new SandboxGoneError({ id: brand.id(name) });
    const container = containerOf(name);
    const found = yield* client.inspect(container);
    if (Option.isNone(found)) {
      return Option.none<SandboxInfo>();
    }
    if (!found.value.running) {
      return yield* gone;
    }
    const read = yield* client.execText(container, "root", [
      "cat",
      "/run/proofbox/deadline",
    ]);
    const deadline = parseDeadline(read.stdout);
    if (read.exitCode !== 0 || Option.isNone(deadline)) {
      const stderr = read.stderr.toLowerCase();
      if (stderr.includes("no such container")) {
        return Option.none<SandboxInfo>();
      }
      if (stderr.includes("is not running")) {
        return yield* gone;
      }
      return yield* failFor(brand)(
        `could not read the Deadline: ${read.stderr.trim() || read.stdout.trim()}`,
      );
    }
    return Option.some(
      yield* sandboxInfoFromLabels(
        brand,
        name,
        found.value.labels,
        deadline.value,
        region,
      ),
    );
  },
);

const readOrGone = Effect.fn("dockerProvider.readOrGone")(function* <E>(
  client: DockerClient<E>,
  brand: ProviderBrand,
  name: string,
) {
  const found = yield* readDockerSandbox(client, brand, name);
  if (Option.isNone(found)) {
    return yield* new SandboxGoneError({ id: brand.id(name) });
  }
  return found.value;
});

const writeDeadline = Effect.fn("dockerProvider.writeDeadline")(function* <E>(
  client: DockerClient<E>,
  brand: ProviderBrand,
  name: string,
  deadline: Date,
) {
  const written = yield* client.execText(containerOf(name), "root", [
    "sh",
    "-c",
    'tmp=/run/proofbox/.deadline.$$; printf "%s\n" "$1" > "$tmp" && mv "$tmp" /run/proofbox/deadline',
    "sh",
    String(Math.floor(deadline.getTime() / 1000)),
  ]);
  if (written.exitCode !== 0) {
    return yield* failFor(brand)(
      `could not write the Deadline: ${written.stderr.trim()}`,
    );
  }
});

const waitForDesktop = Effect.fn("dockerProvider.waitForDesktop")(function* <E>(
  client: DockerClient<E>,
  brand: ProviderBrand,
  container: string,
) {
  const cutoff = (yield* Clock.currentTimeMillis) + 30_000;
  while (true) {
    const result = yield* client.execText(container, "app", [
      "xdpyinfo",
      "-display",
      ":99",
    ]);
    if (result.exitCode === 0) {
      return;
    }
    if ((yield* Clock.currentTimeMillis) >= cutoff) {
      return yield* failFor(brand)("desktop did not start in 30 s");
    }
    yield* Effect.sleep("200 millis");
  }
});

export interface DockerSandboxOptions<E> {
  readonly client: DockerClient<E>;
  readonly fs: FileSystem.FileSystem;
  readonly brand: ProviderBrand;
  readonly imageTag?: string | undefined;
  readonly runArgs?: ReadonlyArray<string>;
  readonly registry?: boolean;
  readonly memoryReserveGb?: number;
}

// A fixed `name` gets one try; a host made before the Sandbox passes its
// own `maxLifeAt`, else the Max life counts from the container's start.
export interface DockerSandboxRequest {
  readonly os: Os;
  readonly idle: Duration.Duration;
  readonly maxLife: Duration.Duration;
  readonly size?: Size | undefined;
  readonly name?: string | undefined;
  readonly maxLifeAt?: Date | undefined;
}

const createWork = Effect.fn("dockerProvider.createWork")(function* <E>(
  options: DockerSandboxOptions<E>,
  req: DockerSandboxRequest,
  image: {
    readonly version: string;
    readonly tag: string;
    readonly bundle: ReadonlyArray<ToolBundleFile>;
  },
) {
  const { client, brand } = options;
  const fail = failFor(brand);
  const size = req.size;
  const { version, tag, bundle } = image;
  const createdAt = yield* now;
  const maxLifeAt =
    req.maxLifeAt ??
    new Date(createdAt.getTime() + Duration.toMillis(req.maxLife));
  const first = firstDeadline({
    now: createdAt,
    idle: req.idle,
    maxLifeAt,
  });
  let name: string | undefined;
  const tries = req.name === undefined ? 5 : 1;
  for (let i = 0; i < tries && name === undefined; i++) {
    const candidate = req.name ?? makeSandboxName();
    const result = yield* client.run([
      "--rm",
      "--init",
      "--name",
      containerOf(candidate),
      "--hostname",
      containerOf(candidate),
      "--shm-size",
      "512m",
      "--tmpfs",
      "/run/proofbox/secrets:mode=0700,uid=1000,gid=1000,size=1m",
      "--label",
      `proofbox.name=${candidate}`,
      "--label",
      `proofbox.os=${req.os}`,
      "--label",
      `proofbox.created-at=${createdAt.toISOString()}`,
      "--label",
      `proofbox.idle-seconds=${Duration.toSeconds(req.idle)}`,
      "--label",
      `proofbox.max-life-at=${maxLifeAt.toISOString()}`,
      "--label",
      `proofbox.base-version=${version}`,
      ...(size === undefined
        ? []
        : [
            "--cpus",
            String(size.cpu),
            "--memory",
            `${size.ramGb - (options.memoryReserveGb ?? 0)}g`,
            "--memory-swap",
            `${size.ramGb - (options.memoryReserveGb ?? 0)}g`,
            "--label",
            `proofbox.size=${formatSize(size)}`,
          ]),
      "--env",
      `PROOFBOX_DEADLINE=${deadlineSeconds(first)}`,
      "--env",
      `PROOFBOX_MAX_LIFE_AT=${Math.floor(maxLifeAt.getTime() / 1000)}`,
      ...(options.runArgs ?? []),
      tag,
    ]);
    if (result.exitCode === 0) {
      name = candidate;
    } else if (
      req.name === undefined &&
      (result.stderr.includes("is already in use") ||
        result.stderr.includes("Conflict"))
    ) {
    } else {
      return yield* fail(`docker run failed: ${result.stderr.trim()}`);
    }
  }
  if (name === undefined) {
    return yield* fail("could not make a Sandbox name after 5 tries");
  }
  const container = containerOf(name);
  const sandboxId = brand.id(name);
  return yield* Effect.gen(function* () {
    yield* waitForDesktop(client, brand, container);
    // The image could have been rebuilt or tampered with since the build;
    // re-check every Tool bundle hash inside the container.
    for (const file of bundle) {
      const sum = yield* client.execText(container, "root", [
        "sha256sum",
        file.path,
      ]);
      if (
        sum.exitCode !== 0 ||
        sum.stdout.trim().split(/\s+/)[0] !== file.sha256
      ) {
        return yield* new ToolBundleHashError({
          file: file.path,
          sandboxId,
          tag,
        });
      }
    }
    const finished = yield* now;
    yield* readOrGone(client, brand, name);
    yield* writeDeadline(
      client,
      brand,
      name,
      nextDeadline({ now: finished, idle: req.idle, maxLifeAt }),
    );
    return yield* readOrGone(client, brand, name);
  }).pipe(
    Effect.catchTag("SandboxGoneError", () =>
      Effect.fail(fail("the container died during Sandbox creation")),
    ),
    Effect.onError(() => Effect.ignore(client.remove(container))),
  );
});

// Makes one Sandbox container: the Base image first when the host lacks it.
export const createDockerSandbox = Effect.fn(
  "dockerProvider.createDockerSandbox",
)(function* <E>(options: DockerSandboxOptions<E>, req: DockerSandboxRequest) {
  const { client } = options;
  // Prove the daemon answers before anything is made — and before the
  // progress line prints, so a dead daemon reports only the error.
  const arch = yield* client.serverArch;
  const version = yield* baseImageVersion(
    BASE_IMAGE_DIR,
    LINUX_TOOL_BUNDLE,
  ).pipe(Effect.provideService(FileSystem.FileSystem, options.fs));
  const bundle = yield* toolBundleForArch(arch);
  const tag = options.imageTag ?? baseImageTag(version);
  yield* ensureBaseImage(
    client,
    {
      dir: BASE_IMAGE_DIR,
      tag,
      buildArgs: { BASE_VERSION: version, ...toolBundleArgs(bundle) },
    },
    { registry: options.registry },
  );
  const progress = yield* Progress;
  return yield* progress.step(
    "creating docker Sandbox",
    createWork(options, req, { version, tag, bundle }),
  );
});

export const makeDockerProvider = (options: {
  readonly client: DockerClient;
  readonly fs: FileSystem.FileSystem;
  readonly imageTag?: string;
}): Provider => {
  const client = options.client;
  const brand = DOCKER_BRAND;
  const fail = failFor(brand);
  const gone = (name: string) => new SandboxGoneError({ id: brand.id(name) });

  const get = Effect.fn("DockerProvider.get")(function* (sandbox: SandboxRef) {
    const name = sandbox.name;
    if (!/^[a-z0-9]{6}$/.test(name)) {
      return yield* gone(name);
    }
    return yield* readOrGone(client, brand, name);
  });

  const extend = (sandbox: SandboxRef, deadline: Date) =>
    Effect.zipRight(
      get(sandbox),
      writeDeadline(client, brand, sandbox.name, deadline),
    );

  const list = Effect.gen(function* () {
    const names = yield* client.listNames;
    const infos = yield* Effect.forEach(
      names,
      (name) =>
        get({ name, region: undefined }).pipe(
          Effect.catchTag("SandboxGoneError", () => Effect.succeed(undefined)),
        ),
      { discard: false },
    );
    return {
      infos: infos.filter((info) => info !== undefined),
      unreached: [],
      unfinished: [],
    };
  }).pipe(
    // proofbox list must work where Docker does not run (a Mac caller).
    Effect.catchTag("ProviderUnavailableError", () =>
      Effect.succeed({ infos: [], unreached: [], unfinished: [] }),
    ),
  );

  const del = Effect.fn("DockerProvider.del")(function* (sandbox: SandboxRef) {
    const name = sandbox.name;
    const found = yield* client.inspect(containerOf(name));
    if (Option.isNone(found)) {
      return "gone" as const;
    }
    const ownedBy = yield* Schema.decodeUnknown(
      Schema.Struct({ "proofbox.name": Schema.String }),
    )(found.value.labels).pipe(Effect.option);
    if (Option.isNone(ownedBy) || ownedBy.value["proofbox.name"] !== name) {
      return "gone" as const;
    }
    yield* client.remove(containerOf(name));
    return "deleted" as const;
  });

  const create = (req: Parameters<Provider["create"]>[0]) =>
    createDockerSandbox(
      { client, fs: options.fs, imageTag: options.imageTag, brand },
      req,
    );

  const connect = Effect.fn("DockerProvider.connect")(function* (
    sandbox: SandboxRef,
  ) {
    const info = yield* get(sandbox);
    const container = containerOf(sandbox.name);
    return {
      info,
      get: get(sandbox),
      extend: (deadline: Date) =>
        writeDeadline(client, brand, sandbox.name, deadline),
      // One root `docker exec` per command: the command run's script
      // pushes, counts, and drops to `app` around it (ADR 0015).
      transport: {
        shell: LINUX_CHECKS,
        call: (argv: ReadonlyArray<string>, options?: ExecOptions) =>
          client.execStream(container, argv, options, "root"),
        gone: () => gone(sandbox.name),
        fail: (reason: string) => fail(reason),
      },
    };
  });

  return {
    name: "docker",
    idPrefix: "docker",
    login: { _tag: "None" },
    loginFiles: [],
    offers: {
      linux: {
        sizes: "any",
        features: new Set(["desktop", "recording", "secrets"]),
      },
    },
    create,
    get,
    list,
    delete: del,
    extend,
    sandboxFolders: () => ({
      state: "/var/lib/proofbox",
      secrets: "/run/proofbox/secrets",
    }),
    connect,
  };
};
