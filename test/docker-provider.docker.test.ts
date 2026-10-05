import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CliOutput } from "../src/cli-output.ts";
import { createSandbox } from "../src/commands/create.ts";
import {
  BASE_IMAGE_DIR,
  baseImageTag,
  baseImageVersion,
} from "../src/docker/base-image.ts";
import { makeDockerClient } from "../src/docker/docker-client.ts";
import { makeDockerProvider } from "../src/docker/docker-provider.ts";
import { ToolBundleHashError } from "../src/errors.ts";
import { KeeperClient } from "../src/keeper/keeper-client.ts";
import { Progress } from "../src/progress.ts";
import {
  type ProviderEntry,
  Providers,
  providerEntry,
} from "../src/provider.ts";
import { TOOL_BUNDLE } from "../src/tool-bundle.ts";
import {
  type CliEnv,
  cleanupEnvs,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./support/cli.ts";
import { nodeFs } from "./support/node-fs.ts";

const docker = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("docker", args, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      }
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return true;
    }
    await sleep(500);
  }
  return false;
};

const containerExists = async (name: string): Promise<boolean> =>
  docker(["ps", "-a", "--format", "{{.Names}}"]).then((out) =>
    out.split("\n").includes(name),
  );

const buildImage = (tag: string, dockerfile: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["build", "-t", tag, "-"],
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
        } else {
          reject(new Error(stderr.trim()));
        }
      },
    );
    child.stdin?.end(dockerfile);
  });

describe("Docker Provider", () => {
  const containers: string[] = [];
  const tamperedTag = "proofbox-test-tampered:1";

  afterAll(async () => {
    await docker(["image", "rm", "-f", tamperedTag]).catch(() => {});
  });

  afterEach(async () => {
    for (const name of containers.splice(0)) {
      await docker(["rm", "-f", name]).catch(() => {});
    }
    cleanupEnvs();
  });

  const containerOf = (id: string) => `proofbox-${id.slice("docker:".length)}`;

  const create = async (env: CliEnv, extra: ReadonlyArray<string> = []) => {
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "docker",
      ...extra,
    ]);
    const id = result.stdout.trim();
    if (/^docker:[a-z0-9]{6}$/.test(id)) {
      containers.push(containerOf(id));
    }
    return result;
  };

  it("create prints a docker Sandbox id with the desktop up", async () => {
    // Given: the docker Provider and a live daemon
    const env = makeEnv({ docker: true });
    // When
    const created = await create(env);
    const id = created.stdout.trim();
    const dimensions = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "xdpyinfo | grep dimensions",
    ]);
    const chromium = await runCli(env, [
      "exec",
      id,
      "--",
      "chromium",
      "--version",
    ]);
    // Then
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toMatch(/^docker:[a-z0-9]{6}\n$/);
    expect(dimensions.stdout).toContain("1440x900 pixels");
    expect(chromium.stdout).toMatch(/^Chromium \d+\./);
  });

  it("exec runs as the app user", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const user = await runCli(env, ["exec", id, "--", "id", "-un"]);
    const uidPwd = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "id -u; pwd",
    ]);
    // Then
    expect(user.stdout).toBe("app\n");
    expect(uidPwd.stdout).toBe("1000\n/home/app\n");
  });

  it("exec through the Keeper moves the Deadline file to idle from now", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--idle", "10m"]);
    const id = created.stdout.trim();
    const t0 = Math.floor(Date.now() / 1000);
    // When
    const run = await runCli(env, ["exec", id, "--", "true"]);
    // Then
    expect(run.exitCode).toBe(0);
    const deadline = await docker([
      "exec",
      containerOf(id),
      "cat",
      "/run/proofbox/deadline",
    ]);
    const pushed = Number(deadline.trim()) - t0;
    expect(pushed).toBeGreaterThanOrEqual(600);
    expect(pushed).toBeLessThanOrEqual(602);
  });

  it("a removed container is gone in the 2 s before the gone-watch sees it", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await docker(["rm", "-f", containerOf(id)]);
    // When
    const run = await runCli(env, ["exec", id, "--", "true"]);
    // Then
    expect(run.stderr).toBe(`Sandbox ${id} is gone\n`);
    expect(run.exitCode).toBe(125);
  });

  it("a command that is not there exits 127", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const run = await runCli(env, ["exec", id, "--", "nosuchcmd"]);
    // Then
    expect(run.exitCode).toBe(127);
    expect(run.stderr).toBe("sh: 1: exec: nosuchcmd: not found\n");
  });

  it("upload sends the Work folder into a docker Sandbox", async () => {
    // Given: a docker Sandbox and the git folder fixture
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const folder = makeGitFolder({
      committed: {
        "a.txt": "a\n",
        "src/b.txt": "b\n",
        ".gitignore": "dist/\n",
      },
      untracked: { "new.txt": "n\n", "dist/out.js": "x\n" },
    });
    // When
    const uploaded = await runCli(env, ["upload", id, folder]);
    const read = await runCli(env, ["exec", id, "--", "cat", "a.txt"]);
    // Then
    expect(uploaded.exitCode).toBe(0);
    expect(uploaded.stderr).toBe(
      "proofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\n",
    );
    expect(read.stdout).toBe("a\n");
  });

  it("list shows the Base image version", async () => {
    // Given: a created docker Sandbox and its image's version label
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const tag = (
      await docker([
        "inspect",
        containerOf(id),
        "--format",
        "{{.Config.Image}}",
      ])
    ).trim();
    const version = (
      await docker([
        "image",
        "inspect",
        tag,
        "--format",
        '{{index .Config.Labels "proofbox.base-version"}}',
      ])
    ).trim();
    // When
    const listed = await runCli(env, ["list"]);
    const json = await runCli(env, ["list", "--json"]);
    // Then
    const row = listed.stdout
      .split("\n")
      .find((line) => line.startsWith(`${id} `) || line.startsWith(id));
    expect(row).toMatch(
      /^docker:[a-z0-9]{6} {2}linux {2}base [0-9a-f]{12} {2}deadline \S+ {2}max life \S+$/,
    );
    expect(row).toContain(`base ${version}`);
    const rows = JSON.parse(json.stdout) as ReadonlyArray<{
      id: string;
      base?: string;
    }>;
    expect(rows.find((entry) => entry.id === id)?.base).toBe(version);
  });

  it("the Base image holds the Tool bundle ffmpeg with its fixed hash", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const sum = await runCli(env, [
      "exec",
      id,
      "--",
      "sha256sum",
      "/opt/proofbox/tools/ffmpeg",
    ]);
    const devices = await runCli(env, [
      "exec",
      id,
      "--",
      "/opt/proofbox/tools/ffmpeg",
      "-hide_banner",
      "-devices",
    ]);
    // Then
    const sha256 =
      process.arch === "x64"
        ? "9a380286db8a65bfadf83b67256e58b0e8fbe0a82781375ec7fd410ebee73f02"
        : "583e6f13cdc325e4633d1d61f2d27bb8baeb234a4f75fca4e0b8f2b9aab09e60";
    expect(sum.stdout).toBe(`${sha256}  /opt/proofbox/tools/ffmpeg\n`);
    expect(devices.stdout).toContain(" x11grab ");
  });

  effectIt.live(
    "a Tool bundle file with a wrong hash fails create and deletes the container",
    () =>
      Effect.gen(function* () {
        // Given: the Base image with a tampered Tool bundle file
        const executor = yield* CommandExecutor.CommandExecutor;
        const version = yield* baseImageVersion(BASE_IMAGE_DIR, TOOL_BUNDLE);
        yield* Effect.promise(() =>
          buildImage(
            tamperedTag,
            `FROM ${baseImageTag(version)}\nRUN echo tampered >> /opt/proofbox/tools/ffmpeg\n`,
          ),
        );
        const providers = Layer.succeed(
          Providers,
          new Map<string, ProviderEntry>([
            [
              "docker",
              providerEntry(
                makeDockerProvider({
                  client: makeDockerClient(executor),
                  fs: nodeFs,
                  imageTag: tamperedTag,
                }),
              ),
            ],
          ]),
        );
        // When
        const error = yield* Effect.flip(
          createSandbox({ os: "linux", provider: "docker" }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeContext.layer,
                CliOutput.Test,
                providers,
                KeeperClient.Direct.pipe(Layer.provide(providers)),
                Layer.succeed(
                  Progress,
                  new Progress({
                    step: (_label, effect) => effect,
                    warn: () => Effect.void,
                    note: () => Effect.void,
                  }),
                ),
              ),
            ),
          ),
        );
        // Then
        expect(error._tag).toBe("ToolBundleHashError");
        if (!(error instanceof ToolBundleHashError)) {
          throw new Error(`unexpected error ${error._tag}`);
        }
        expect(error.file).toBe("/opt/proofbox/tools/ffmpeg");
        expect(error.sandboxId).toMatch(/^docker:[a-z0-9]{6}$/);
        const container = containerOf(error.sandboxId);
        containers.push(container);
        expect(yield* Effect.promise(() => containerExists(container))).toBe(
          false,
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("create --size 2x3 gives the container 2 CPUs and 3 GB", async () => {
    // Given
    const env = makeEnv({ docker: true });
    // When
    const created = await create(env, ["--size", "2x3"]);
    const container = containerOf(created.stdout.trim());
    const inspected = await docker([
      "inspect",
      "-f",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
      container,
    ]);
    // Then
    expect(inspected).toBe("2000000000 3221225472\n");
  });

  it("create with no --size gives the container no limit", async () => {
    // Given
    const env = makeEnv({ docker: true });
    // When
    const created = await create(env);
    const container = containerOf(created.stdout.trim());
    const inspected = await docker([
      "inspect",
      "-f",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
      container,
    ]);
    // Then
    expect(inspected).toBe("0 0\n");
  });

  it("a command killed for memory exits 122 and names the next size", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--size", "1x1"]);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "head -c 3000m /dev/zero | tail",
    ]);
    // Then
    expect(result.exitCode).toBe(122);
    expect(
      result.stderr.endsWith(
        "Sandbox ran out of memory (1x1). Try --size 2x2.\n",
      ),
    ).toBe(true);
  });

  it("a pipeline killed for memory before its last stage exits 122", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--size", "1x1"]);
    const id = created.stdout.trim();
    // When: the heavy stage is not the last, so the shell reports exit 0
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "head -c 3000m /dev/zero | tail | cat > /dev/null",
    ]);
    // Then
    expect(result.exitCode).toBe(122);
    expect(
      result.stderr.endsWith(
        "Sandbox ran out of memory (1x1). Try --size 2x2.\n",
      ),
    ).toBe(true);
  });

  it("delete removes the container", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const deleted = await runCli(env, ["delete", id]);
    // Then
    expect(deleted.stdout).toBe(`Deleted ${id}\n`);
    expect(await containerExists(containerOf(id))).toBe(false);
  });

  it("delete leaves a container that is not a Sandbox alone", async () => {
    // Given: a container borrowing the proofbox- name without the label
    const env = makeEnv({ docker: true });
    await docker([
      "run",
      "-d",
      "--name",
      "proofbox-zzzzzz",
      "debian:bookworm-slim",
      "sleep",
      "60",
    ]);
    containers.push("proofbox-zzzzzz");
    // When
    const deleted = await runCli(env, ["delete", "docker:zzzzzz"]);
    // Then
    expect(deleted.stdout).toBe("Sandbox docker:zzzzzz is already gone\n");
    expect(await containerExists("proofbox-zzzzzz")).toBe(true);
  });

  it("the watchdog deletes the container at the Deadline with no Caller process alive", async () => {
    // Given: a docker Sandbox with a 5 s idle and a live Keeper
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--idle", "5s"]);
    const id = created.stdout.trim();
    const name = containerOf(id);
    const pidPath = join(
      env.runtime,
      `docker-${id.slice("docker:".length)}.pid`,
    );
    expect(await waitUntil(async () => existsSync(pidPath), 10_000)).toBe(true);
    // When: the Keeper dies without cleaning up
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid, "SIGKILL");
    // Then: the in-container watchdog still kills the container
    expect(
      await waitUntil(async () => !(await containerExists(name)), 30_000),
    ).toBe(true);
  });

  it("each exec pushes the watchdog Deadline", async () => {
    // Given: a docker Sandbox with a 6 s idle
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--idle", "6s"]);
    const id = created.stdout.trim();
    const name = containerOf(id);
    // When: four execs land two seconds apart
    for (let i = 0; i < 4; i++) {
      const ran = await runCli(env, ["exec", id, "--", "true"]);
      expect(ran.exitCode).toBe(0);
      await sleep(2000);
    }
    // Then: well past the first Deadline the Sandbox is alive, then dies
    expect(await containerExists(name)).toBe(true);
    expect(
      await waitUntil(async () => !(await containerExists(name)), 30_000),
    ).toBe(true);
  });

  it("the watchdog stops the container at the Max life", async () => {
    // Given: a docker Sandbox with an 8 s Max life and a 1 h idle
    const env = makeEnv({ docker: true });
    const created = await create(env, ["--idle", "1h", "--max-life", "8s"]);
    const id = created.stdout.trim();
    // When: an exec keeps the idle Deadline out of reach
    const ran = await runCli(env, ["exec", id, "--", "true"]);
    expect(ran.exitCode).toBe(0);
    // Then: the Max life still wins
    expect(
      await waitUntil(
        async () => !(await containerExists(containerOf(id))),
        30_000,
      ),
    ).toBe(true);
  });

  it("the Secrets live only in a tmpfs, and docker commit holds none", {
    timeout: 300_000,
  }, async () => {
    // Given: a docker Sandbox created with an env file
    const env = makeEnv({ docker: true });
    const dir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
    trackTempDir(dir);
    const path = join(dir, "app.env");
    writeFileSync(path, "API_TOKEN=tok-5f2a9c\n");
    chmodSync(path, 0o600);
    const created = await create(env, ["--env-file", path]);
    const id = created.stdout.trim();
    const name = id.slice("docker:".length);
    const tag = `proofbox-test-commit:${name}`;
    try {
      // When
      const mount = await runCli(env, [
        "exec",
        id,
        "--",
        "sh",
        "-c",
        "stat -c %a /run/proofbox/secrets; stat -f -c %T /run/proofbox/secrets",
      ]);
      const seen = await runCli(env, [
        "exec",
        id,
        "--",
        "printenv",
        "API_TOKEN",
      ]);
      await docker(["commit", containerOf(id), tag]);
      const found = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        tag,
        "-c",
        "if grep -rqsF tok-5f2a9c / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev; then echo found; else echo clean; fi; ls -A /run/proofbox/secrets",
      ]);
      const inspected = await docker(["image", "inspect", tag]);
      // Then
      expect(mount.stdout).toBe("700\ntmpfs\n");
      expect(seen.stdout).toBe("tok-5f2a9c\n");
      expect(found).toBe("clean\n");
      expect(inspected).not.toContain("tok-5f2a9c");
    } finally {
      await docker(["image", "rm", tag]).catch(() => {});
    }
  });
});
