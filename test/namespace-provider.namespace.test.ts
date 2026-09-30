import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CliEnv,
  cleanupEnvs,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./support/cli.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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

const tempFile = (name: string, content: string, mode = 0o644) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-file-"));
  trackTempDir(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
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
    if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
      hosts.push(id.split(":").at(-1) ?? "");
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
    expect(created.stdout).toMatch(/^ns:[a-z0-9]+:[a-z0-9]+\n$/);
    expect(dimensions.stdout).toContain("1440x900 pixels");
    expect(chromium.stdout).toMatch(/^Chromium \d+\./);
  });

  it("a second create reuses the Snapshot, skips the Setup script, and holds no Secret", async () => {
    // Given: a lockfile no earlier run had, so the Fingerprint is new
    const env = makeEnv({ docker: true, namespace: true });
    const folder = makeGitFolder({
      committed: {
        "a.txt": "a\n",
        "pnpm-lock.yaml": `lockfileVersion: '9.0'\n# run ${Date.now()}\n`,
      },
    });
    const script = tempFile("setup.sh", "#!/bin/sh\necho ran >> runs.txt\n");
    const envPath = tempFile("app.env", "API_TOKEN=tok-5f2a9c\n", 0o600);
    // When
    const first = await create(env, [
      "--work",
      folder,
      "--setup",
      script,
      "--env-file",
      envPath,
    ]);
    const fp = /Snapshot saved, Fingerprint ([0-9a-f]{12})/.exec(
      first.stderr,
    )?.[1];
    const second = await create(env, ["--work", folder, "--setup", script]);
    const id = second.stdout.trim();
    const runs = await runCli(env, ["exec", id, "--", "cat", "runs.txt"]);
    const found = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "if grep -rqsF tok-5f2a9c / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev; then echo found; else echo clean; fi",
    ]);
    // Then
    expect({
      saved: fp !== undefined,
      reused: second.stderr.includes(
        `proofbox: Snapshot reused, Fingerprint ${fp}\n`,
      ),
      setupRan: second.stderr.includes("proofbox: running Setup script"),
      runs: runs.stdout,
      found: found.stdout,
    }).toEqual({
      saved: true,
      reused: true,
      setupRan: false,
      runs: "ran\n",
      found: "clean\n",
    });
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
    const host = created.stdout.trim().split(":").at(-1) ?? "";
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
    const host = created.stdout.trim().split(":").at(-1) ?? "";
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

  it("a 16x32 host over the workspace cap is refused and leaves nothing", async () => {
    // Given: this workspace caps one host at 8x16
    const env = makeEnv({ docker: true, namespace: true });
    const before = await liveIds();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "namespace",
      "--size",
      "16x32",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr.startsWith("Namespace refused the Sandbox: ")).toBe(
      true,
    );
    expect(result.stderr).toContain("maximum 8x16");
    expect(
      result.stderr.endsWith(
        "nothing was created. Delete a Sandbox or use a smaller --size\n",
      ),
    ).toBe(true);
    expect(await liveIds()).toEqual(before);
  });

  it("the host is deleted at its Deadline with no Caller alive", async () => {
    // Given: a created ns: Sandbox with a 2 m idle; its Keeper is then killed
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env, ["--idle", "2m"]);
    const id = created.stdout.trim();
    const host = id.split(":").at(-1) ?? "";
    const start = Date.now();
    const pidPath = join(env.runtime, `ns-${id.slice("ns:".length)}.pid`);
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
    const host = id.split(":").at(-1) ?? "";
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

  it("live prints a local address and a password that open the desktop", async () => {
    // Given: a created ns: Sandbox
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When: `live` as a child; read its first two stdout lines
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/main.ts", "live", id],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env.env },
      },
    );
    let port = 0;
    try {
      const lines = await new Promise<string[]>((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          const found = text.split("\n").filter((line) => line !== "");
          if (found.length >= 2) {
            resolve(found.slice(0, 2));
          }
        });
        child.on("exit", (code) =>
          reject(new Error(`live exited ${code}: ${text}`)),
        );
      });
      // Then
      const [address, passwordLine] = lines as [string, string];
      expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(passwordLine).toMatch(/^password [a-z0-9]{8}$/);
      port = Number(address.split(":")[1]);
      const greeting = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("data", (data) => {
          socket.destroy();
          resolve(data);
        });
        socket.once("error", reject);
      });
      expect(greeting.subarray(0, 12).toString("utf8")).toBe("RFB 003.008\n");
    } finally {
      child.kill("SIGINT");
    }
    // And after SIGINT the child exits and the address refuses a connection
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  it("the host has only a private address and no ingress", async () => {
    // Given: a created ns: Sandbox with `live` running
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const host = id.split(":").at(-1) ?? "";
    const stem = id.slice("ns:".length);
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/main.ts", "live", id],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env.env },
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          if (text.split("\n").filter((line) => line !== "").length >= 2) {
            resolve();
          }
        });
        child.on("exit", (code) =>
          reject(new Error(`live exited ${code}: ${text}`)),
        );
      });
      // When
      const entry = (await liveList()).find((item) => item.cluster_id === host);
      const ctl = join(env.runtime, `ns-${stem}.ctl`);
      const key = join(env.runtime, `ns-${stem}.sshkey`);
      expect(await waitUntil(async () => existsSync(ctl), 30_000)).toBe(true);
      const ip = await new Promise<string>((resolve, reject) => {
        execFile(
          "ssh",
          [
            "-S",
            ctl,
            "-i",
            key,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "root@127.0.0.1",
            "ip -4 -o addr show scope global",
          ],
          (error, stdout, stderr) =>
            error === null
              ? resolve(stdout)
              : reject(new Error(stderr || error.message)),
        );
      });
      // Then
      expect(entry === undefined || !("ingress" in entry)).toBe(true);
      const addresses = [...ip.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)].map(
        (match) => match[1] as string,
      );
      const isPrivate = (address: string) =>
        address.startsWith("10.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(address) ||
        address.startsWith("192.168.");
      expect(addresses.length).toBeGreaterThan(0);
      // eth0 sits in 10.0.0.0/30; docker0 adds 172.16.0.0/12 — all private,
      // nothing public (the point of the check).
      for (const address of addresses) {
        expect(isPrivate(address)).toBe(true);
      }
    } finally {
      child.kill("SIGINT");
    }
  });
});
