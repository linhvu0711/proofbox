import { Clock, Duration, Effect, Option, Schema } from "effect";
import { nextDeadline } from "../deadline.ts";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import { Progress } from "../progress.ts";
import { Os, type Provider, SandboxInfo } from "../provider.ts";
import { makeSandboxName } from "../sandbox-id.ts";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
  ensureBaseImage,
} from "./base-image.ts";
import type { DockerClient } from "./docker-client.ts";

const Labels = Schema.Struct({
  "proofbox.name": Schema.String,
  "proofbox.os": Os,
  "proofbox.created-at": Schema.Date,
  "proofbox.idle-seconds": Schema.NumberFromString,
  "proofbox.max-life-at": Schema.Date,
  "proofbox.base-version": Schema.optional(Schema.String),
});

export const makeDockerProvider = (options: {
  readonly client: DockerClient;
  readonly imageTag?: string;
}): Provider => {
  const client = options.client;
  const fail = (reason: string) =>
    new ProviderError({ provider: "docker", reason });
  const gone = (name: string) => new SandboxGoneError({ id: `docker:${name}` });
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
      const labels = yield* Schema.decodeUnknown(Labels)(
        found.value.labels,
      ).pipe(Effect.mapError((error) => fail(error.message)));
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
      return new SandboxInfo({
        name,
        os: labels["proofbox.os"],
        createdAt: labels["proofbox.created-at"],
        idleSeconds: labels["proofbox.idle-seconds"],
        deadline: new Date(seconds * 1000),
        maxLifeAt: labels["proofbox.max-life-at"],
      });
    });

  const extend = (name: string, deadline: Date) =>
    Effect.gen(function* () {
      yield* get(name);
      const written = yield* client.execText(containerOf(name), "root", [
        "sh",
        "-c",
        'printf "%s\n" "$1" > /run/proofbox/deadline',
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

  const createWork = (req: {
    readonly os: Os;
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
  }) =>
    Effect.gen(function* () {
      const version = yield* baseImageVersion(BASE_IMAGE_DIR, []);
      const tag = options.imageTag ?? baseImageTag(version);
      yield* ensureBaseImage(client, {
        dir: BASE_IMAGE_DIR,
        tag,
        buildArgs: { BASE_VERSION: version },
      });
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
      for (let i = 0; i < 5 && name === undefined; i++) {
        const candidate = makeSandboxName();
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
          "--env",
          `PROOFBOX_DEADLINE=${Math.floor(firstDeadline.getTime() / 1000)}`,
          "--env",
          `PROOFBOX_MAX_LIFE_AT=${Math.floor(maxLifeAt.getTime() / 1000)}`,
          tag,
        ]);
        if (result.exitCode === 0) {
          name = candidate;
        } else if (
          result.stderr.includes("is already in use") ||
          result.stderr.includes("Conflict")
        ) {
        } else {
          return yield* fail(`docker run failed: ${result.stderr.trim()}`);
        }
      }
      if (name === undefined) {
        return yield* fail("could not make a Sandbox name after 5 tries");
      }
      const container = containerOf(name);
      return yield* Effect.gen(function* () {
        yield* waitForDesktop(container);
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
  }) =>
    Effect.gen(function* () {
      // Prove the daemon answers before anything is made — and before the
      // progress line prints, so a dead daemon reports only the error.
      yield* client.serverArch;
      const progress = yield* Progress;
      return yield* progress.step("creating docker Sandbox", createWork(req));
    });

  const connect = (name: string) =>
    Effect.gen(function* () {
      yield* get(name);
      const container = containerOf(name);
      return {
        exec: (argv: ReadonlyArray<string>) =>
          client.execStream(container, argv),
      };
    });

  return {
    name: "docker",
    capabilities: new Set(["os:linux"]),
    create,
    get,
    list,
    delete: del,
    extend,
    connect,
  };
};
