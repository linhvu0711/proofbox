import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

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

describe("Docker Provider", () => {
  const containers: string[] = [];

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
});
