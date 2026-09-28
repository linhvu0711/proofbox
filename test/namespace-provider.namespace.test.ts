import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const nscBin = () => process.env.PROOFBOX_NSC ?? "nsc";

const nsc = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(nscBin(), args, (error, stdout, stderr) => {
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

// Sleep until `ms` after `start`, so a step lands on its mark even when the
// previous step ran long.
const sleepUntil = async (start: number, ms: number) => {
  const left = start + ms - Date.now();
  if (left > 0) {
    await sleep(left);
  }
};

const liveList = async (): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const out = await nsc(["list", "-o", "json"]);
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
};

const liveIds = async (): Promise<ReadonlyArray<string>> =>
  (await liveList()).map((entry) => String(entry.cluster_id ?? ""));

describe("Namespace Provider", () => {
  const hosts: string[] = [];

  afterEach(async () => {
    for (const id of hosts.splice(0)) {
      await nsc(["destroy", id, "--force"]).catch(() => {});
    }
    cleanupEnvs();
  });

  const create = async (env: CliEnv, extra: ReadonlyArray<string> = []) => {
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "namespace",
      ...extra,
    ]);
    const id = result.stdout.trim();
    if (/^ns:[a-z0-9]+$/.test(id)) {
      hosts.push(id.slice("ns:".length));
    }
    return result;
  };

  it("create prints an ns Sandbox id with the desktop up", async () => {
    // Given: a real Namespace account (nsc auth check-login exits 0)
    const env = makeEnv({ docker: true, namespace: true });
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
    expect(created.stdout).toMatch(/^ns:[a-z0-9]+\n$/);
    expect(dimensions.stdout).toContain("1440x900 pixels");
    expect(chromium.stdout).toMatch(/^Chromium \d+\./);
  });

  it("exec runs as the app user", async () => {
    // Given: a created ns: Sandbox
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const whoami = await runCli(env, ["exec", id, "--", "id", "-un"]);
    // Then
    expect(whoami.stdout).toBe("app\n");
    expect(whoami.exitCode).toBe(0);
  });

  it("create on a real host passes both token checks", async () => {
    // Given: a real account
    const env = makeEnv({ docker: true, namespace: true });
    // When
    const created = await create(env);
    // Then
    expect(created.exitCode).toBe(0);
    expect(created.stderr).toContain(
      "proofbox: checking the Namespace token is out of reach\n",
    );
  });

  it("a warm exec takes under 3 s", async () => {
    // Given: a created ns: Sandbox whose Keeper already holds the link
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const cold = await runCli(env, ["exec", id, "--", "true"]);
    // When
    const start = performance.now();
    const warm = await runCli(env, ["exec", id, "--", "true"]);
    const millis = performance.now() - start;
    // Then
    expect(cold.exitCode).toBe(0);
    expect(warm.exitCode).toBe(0);
    expect(millis).toBeLessThan(3000);
  });

  it("create with no --size makes a 4x8 host", async () => {
    // Given: a real account
    const env = makeEnv({ docker: true, namespace: true });
    // When
    const created = await create(env);
    const host = created.stdout.trim().slice("ns:".length);
    // Then
    const entry = (await liveList()).find((item) => item.cluster_id === host);
    const shape = (entry?.shape ?? {}) as Record<string, unknown>;
    expect(shape.virtual_cpu).toBe(4);
    expect(shape.memory_megabytes).toBe(8192);
    expect(shape.machine_arch).toBe("amd64");
    expect(shape.os).toBe("linux");
  });

  it("create --size 8x16 makes an 8x16 host", async () => {
    // Given: a real account
    const env = makeEnv({ docker: true, namespace: true });
    // When
    const created = await create(env, ["--size", "8x16"]);
    const host = created.stdout.trim().slice("ns:".length);
    // Then
    const entry = (await liveList()).find((item) => item.cluster_id === host);
    const shape = (entry?.shape ?? {}) as Record<string, unknown>;
    expect(shape.virtual_cpu).toBe(8);
    expect(shape.memory_megabytes).toBe(16384);
  });

  it("a command killed for memory on 4x8 says Try --size 8x16", async () => {
    // Given: a 4x8 Sandbox (container limit 7 GB)
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "head -c 8000m /dev/zero | tail",
    ]);
    // Then
    expect(result.exitCode).toBe(122);
    expect(
      result.stderr.endsWith(
        "Sandbox ran out of memory (4x8). Try --size 8x16.\n",
      ),
    ).toBe(true);
  });

  it("at 16x32 the memory error says it is the largest size", async () => {
    // Given: a 16x32 Sandbox (container limit 31 GB)
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env, ["--size", "16x32"]);
    const id = created.stdout.trim();
    const host = id.slice("ns:".length);
    const entry = (await liveList()).find((item) => item.cluster_id === host);
    const shape = (entry?.shape ?? {}) as Record<string, unknown>;
    expect(shape.virtual_cpu).toBe(16);
    expect(shape.memory_megabytes).toBe(32768);
    // When
    const result = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "head -c 33000m /dev/zero | tail",
    ]);
    // Then
    expect(result.exitCode).toBe(122);
    expect(
      result.stderr.endsWith(
        "Sandbox ran out of memory (16x32). 16x32 is the largest size.\n",
      ),
    ).toBe(true);
  });

  it("the host is deleted at its Deadline with no Caller alive", async () => {
    // Given: a created ns: Sandbox with a 2 m idle; its Keeper is then killed
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env, ["--idle", "2m"]);
    const id = created.stdout.trim();
    const host = id.slice("ns:".length);
    const start = Date.now();
    const pidPath = join(env.runtime, `ns-${host}.pid`);
    expect(await waitUntil(async () => existsSync(pidPath), 30_000)).toBe(true);
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid, "SIGKILL");
    // When: 100 s and 240 s after create returned
    // (the host duration is idle + 60 s, so 180 s here)
    await sleepUntil(start, 100_000);
    const at100 = await liveIds();
    await sleepUntil(start, 240_000);
    const at240 = await liveIds();
    // Then
    expect(at100).toContain(host);
    expect(at240).not.toContain(host);
  });

  it("execs push the host Deadline but never past the Max life", async () => {
    // Given: a created ns: Sandbox with 1 m idle and a 3 m max life
    // (the host starts with idle + 60 s = 120 s to live)
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env, ["--idle", "1m", "--max-life", "3m"]);
    const id = created.stdout.trim();
    const host = id.slice("ns:".length);
    const start = Date.now();
    // When: an exec every 30 s until 150 s — past the first 120 s duration
    let at150 = { exitCode: -1, stderr: "" };
    for (const mark of [30_000, 60_000, 90_000, 120_000, 150_000]) {
      await sleepUntil(start, mark);
      const result = await runCli(env, ["exec", id, "--", "true"]);
      expect(result.exitCode).toBe(0);
      at150 = result;
    }
    // Then: an exec after the max life names the Sandbox gone
    await sleepUntil(start, 185_000);
    const late = await runCli(env, ["exec", id, "--", "true"]);
    expect(late.exitCode).toBe(125);
    expect(late.stderr).toBe(`Sandbox ${id} is gone\n`);
    await sleepUntil(start, 250_000);
    expect(await liveIds()).not.toContain(host);
    expect(at150.exitCode).toBe(0);
  });
});
