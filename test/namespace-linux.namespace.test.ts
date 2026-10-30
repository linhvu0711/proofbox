import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CliEnv,
  cleanupEnvs,
  makeEnv,
  runCli,
  trackTempDir,
} from "./support/cli.ts";
import { destroyHost } from "./support/namespace-live.ts";

// Real Namespace hosts cost money, so the describe makes one Linux host,
// shares it, and deletes it.

describe("Namespace Linux Provider over sshd", () => {
  let env: CliEnv;
  let id: string;

  beforeAll(async () => {
    env = makeEnv({ docker: true, namespace: true });
    const created = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "namespace",
    ]);
    id = created.stdout.trim();
    expect(created.exitCode, created.stderr).toBe(0);
  });

  afterAll(async () => {
    if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroyHost(id.split(":").at(-2) ?? "", id.split(":").at(-1) ?? "");
    }
    cleanupEnvs();
  });

  it("cat of a 3.1 MB file ends 25 times in a row", async () => {
    // Given: the host from beforeAll and 3100000 ASCII bytes in /tmp/big
    const written = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "head -c 2325000 /dev/urandom | base64 | tr -d '\\n' > /tmp/big",
    ]);
    expect(written.exitCode, written.stderr).toBe(0);
    // When
    for (let n = 0; n < 25; n++) {
      const start = performance.now();
      const found = await runCli(env, ["exec", id, "--", "cat", "/tmp/big"], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 40_000,
      });
      const millis = performance.now() - start;
      // Then
      expect(found.exitCode, found.stderr).toBe(0);
      expect(found.stdout.length).toBe(3100000);
      expect(millis).toBeLessThan(10000);
    }
  });

  it("record stop after 25 Step marks gets its Proof video with no stall line", async () => {
    // Given: the host from beforeAll, a Recording with 25 Step marks
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    trackTempDir(dir);
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode, started.stderr).toBe(0);
    for (let n = 1; n <= 25; n++) {
      const marked = await runCli(env, [
        "mark",
        id,
        `step ${n}: open the menu`,
      ]);
      expect(marked.exitCode, marked.stderr).toBe(0);
      await runCli(env, [
        "click",
        id,
        "720",
        "450",
        "--button",
        "right",
        "--pace",
        "fast",
      ]);
      await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    }
    // When
    const stopped = await runCli(
      env,
      ["record", "stop", id, "--out", join(dir, "proof.mp4")],
      { timeout: 300_000 },
    );
    // Then
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(stopped.stderr).not.toContain("sent no bytes");
    const bytes = readFileSync(join(dir, "proof.mp4"));
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
  }, 900_000);

  it("exec sh -c 'exit 3' on Linux exits 3", async () => {
    // Given: the host from beforeAll
    // When
    const found = await runCli(env, ["exec", id, "--", "sh", "-c", "exit 3"]);
    // Then
    expect(found.exitCode).toBe(3);
  });

  it("Ctrl-C ends a Linux exec within 10 s", async () => {
    // Given: the host from beforeAll
    // When: Ctrl-C 5 s after a 600 s command starts
    const start = performance.now();
    await runCli(env, ["exec", id, "--", "sleep", "600"], {
      onSpawn: (interrupt) => {
        setTimeout(interrupt, 5000);
      },
    });
    const millis = performance.now() - start;
    // Then
    expect(millis).toBeLessThan(15000);
  });

  it("a quiet 600 s exec on Linux ends with exit 0", async () => {
    // Given: the host from beforeAll
    // When
    const start = performance.now();
    const found = await runCli(env, ["exec", id, "--", "sleep", "600"], {
      timeout: 700_000,
    });
    const millis = performance.now() - start;
    // Then
    expect(found.exitCode).toBe(0);
    expect(millis).toBeGreaterThanOrEqual(600000);
    expect(millis).toBeLessThan(660000);
  }, 720_000);
});
