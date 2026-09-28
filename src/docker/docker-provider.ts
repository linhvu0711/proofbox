import { Clock, Duration, Effect, Option, Schema } from "effect";
import { nextDeadline } from "../deadline.ts";
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
} from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import { formatSize, parseSize, type Size } from "../size.ts";
import { TOOL_BUNDLE } from "../tool-bundle.ts";
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
  "proofbox.idle-seconds": Schema.NumberFromString,
  "proofbox.max-life-at": Schema.Date,
  "proofbox.base-version": Schema.optional(Schema.String),
  "proofbox.size": Schema.optional(Schema.String),
});

export interface ProviderBrand {
  readonly provider: string;
  readonly id: (name: string) => string;
}

const DOCKER_BRAND: ProviderBrand = {
  provider: "docker",
  id: (name) => `docker:${name}`,
};

// Labels and the Deadline file are the whole persisted state; both the
// local Docker Provider and the Namespace Provider build SandboxInfo the
// same way from them.
export const sandboxInfoFromLabels = (
  brand: ProviderBrand,
  name: string,
  rawLabels: unknown,
  deadlineSeconds: number,
): Effect.Effect<SandboxInfo, ProviderError | SandboxGoneError> =>
  Effect.gen(function* () {
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
      os: labels["proofbox.os"],
      createdAt: labels["proofbox.created-at"],
      idleSeconds: labels["proofbox.idle-seconds"],
      deadline: new Date(deadlineSeconds * 1000),
      maxLifeAt: labels["proofbox.max-life-at"],
      base: labels["proofbox.base-version"],
      size,
    });
  });

export const makeDockerProvider = (options: {
  readonly client: DockerClient;
  readonly imageTag?: string;
  readonly runArgs?: ReadonlyArray<string>;
  readonly registry?: boolean;
  readonly brand?: ProviderBrand;
}): Provider => {
  const client = options.client;
  const brand = options.brand ?? DOCKER_BRAND;
  const fail = (reason: string) =>
    new ProviderError({ provider: brand.provider, reason });
  const gone = (name: string) => new SandboxGoneError({ id: brand.id(name) });
  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));
  const containerOf = (name: string) => `proofbox-${name}`;

  const get = (name: string) =>
    Effect.gen(function* () {
      if (!/^[a-z0-9]{6}$/.test(name)) {
        return yield* gone(name);
      }
      const container = containerOf(name);
      const found = yield* client.inspect(container);
      if (Option.isNone(found) || !found.value.running) {
        return yield* gone(name);
      }
      const read = yield* client.execText(container, "root", [
        "cat",
        "/run/proofbox/deadline",
      ]);
      const seconds = Number(read.stdout.trim());
      if (read.exitCode !== 0 || !Number.isFinite(seconds)) {
        return yield* fail(
          `could not read the Deadline: ${read.stderr.trim() || read.stdout.trim()}`,
        );
      }
      return yield* sandboxInfoFromLabels(
        brand,
        name,
        found.value.labels,
        seconds,
      );
    });

  const extend = (name: string, deadline: Date) =>
    Effect.gen(function* () {
      yield* get(name);
      const written = yield* client.execText(containerOf(name), "root", [
        "sh",
        "-c",
        'tmp=/run/proofbox/.deadline.$$; printf "%s\n" "$1" > "$tmp" && mv "$tmp" /run/proofbox/deadline',
        "sh",
        String(Math.floor(deadline.getTime() / 1000)),
      ]);
      if (written.exitCode !== 0) {
        return yield* fail(
          `could not write the Deadline: ${written.stderr.trim()}`,
        );
      }
      return yield* get(name);
    });

  const list = Effect.gen(function* () {
    const names = yield* client.listNames;
    const infos = yield* Effect.forEach(
      names,
      (name) =>
        get(name).pipe(
          Effect.catchTag("SandboxGoneError", () => Effect.succeed(undefined)),
        ),
      { discard: false },
    );
    return infos.filter((info) => info !== undefined);
  }).pipe(
    // proofbox list must work where Docker does not run (a Mac caller).
    Effect.catchTag("ProviderUnavailableError", () => Effect.succeed([])),
  );

  const del = (name: string) =>
    Effect.gen(function* () {
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

  const waitForDesktop = (container: string) =>
    Effect.gen(function* () {
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
          return yield* fail("desktop did not start in 30 s");
        }
        yield* Effect.sleep("200 millis");
      }
    });

  const createWork = (
    req: {
      readonly os: Os;
      readonly idle: Duration.Duration;
      readonly maxLife: Duration.Duration;
      readonly name?: string | undefined;
    },
    image: {
      readonly version: string;
      readonly tag: string;
      readonly bundle: ReadonlyArray<ToolBundleFile>;
    },
    size?: Size,
  ) =>
    Effect.gen(function* () {
      const { version, tag, bundle } = image;
      const createdAt = yield* now;
      const maxLifeAt = new Date(
        createdAt.getTime() + Duration.toMillis(req.maxLife),
      );
      const firstDeadline = new Date(
        Math.min(
          createdAt.getTime() + Duration.toMillis(req.idle) + 60_000,
          maxLifeAt.getTime(),
        ),
      );
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
                `${size.ramGb}g`,
                "--memory-swap",
                `${size.ramGb}g`,
                "--label",
                `proofbox.size=${formatSize(size)}`,
              ]),
          "--env",
          `PROOFBOX_DEADLINE=${Math.floor(firstDeadline.getTime() / 1000)}`,
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
        yield* waitForDesktop(container);
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
        return yield* extend(
          name as string,
          nextDeadline({ now: finished, idle: req.idle, maxLifeAt }),
        );
      }).pipe(
        Effect.catchTag("SandboxGoneError", () =>
          Effect.fail(fail("the container died during Sandbox creation")),
        ),
        Effect.onError(() => Effect.ignore(client.remove(container))),
      );
    });

  const create = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
  }) =>
    Effect.gen(function* () {
      // Prove the daemon answers before anything is made — and before the
      // progress line prints, so a dead daemon reports only the error.
      const arch = yield* client.serverArch;
      const version = yield* baseImageVersion(BASE_IMAGE_DIR, TOOL_BUNDLE);
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
        createWork(req, { version, tag, bundle }, req.size),
      );
    });

  const connect = (name: string) =>
    Effect.gen(function* () {
      yield* get(name);
      const container = containerOf(name);
      return {
        exec: (argv: ReadonlyArray<string>, options?: ExecOptions) =>
          client.execStream(container, argv, options),
      };
    });

  const memoryKills = (name: string) =>
    Effect.gen(function* () {
      yield* get(name);
      const read = yield* client.execText(containerOf(name), "root", [
        "sh",
        "-c",
        "cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control",
      ]);
      const match = /^oom_kill (\d+)$/m.exec(read.stdout);
      return match === null ? 0 : Number(match[1]);
    });

  return {
    name: "docker",
    idPrefix: "docker",
    capabilities: new Set(["os:linux"]),
    sizes: "any",
    create,
    get,
    list,
    delete: del,
    extend,
    stateDir: () => "/var/lib/proofbox",
    connect,
    memoryKills,
  };
};
