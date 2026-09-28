import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { startNoise } from "./support/noise.ts";

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

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("Recording and the Proof video", () => {
  const containers: string[] = [];

  afterEach(async () => {
    for (const name of containers.splice(0)) {
      await docker(["rm", "-f", name]).catch(() => {});
    }
    cleanupEnvs();
  });

  const containerOf = (id: string) => `proofbox-${id.slice("docker:".length)}`;

  const create = async (env: CliEnv) => {
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "docker",
    ]);
    const id = result.stdout.trim();
    if (/^docker:[a-z0-9]{6}$/.test(id)) {
      containers.push(containerOf(id));
    }
    return result;
  };

  it("record start then record stop --out downloads an H.264 MP4 with the index first", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
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
    await wait(3000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const out = join(dir, "proof.mp4");
    expect(result.stdout).toBe(`${out}\n`);
    const bytes = readFileSync(out);
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
    const probe = await runCli(env, [
      "exec",
      id,
      "--",
      "/opt/proofbox/tools/ffmpeg",
      "-hide_banner",
      "-i",
      "/run/proofbox/recordings/1/proof.mp4",
    ]);
    expect(probe.stderr).toContain("h264 (High)");
    expect(probe.stderr).toContain("yuv420p");
  });

  it("each mark gives a caption bar above the picture, so the video grows to 1440x972", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
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
    await wait(2000);
    await runCli(env, ["mark", id, "step 2: close the menu"]);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await wait(2000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const probe = await runCli(env, [
      "exec",
      id,
      "--",
      "/opt/proofbox/tools/ffmpeg",
      "-hide_banner",
      "-i",
      "/run/proofbox/recordings/1/proof.mp4",
    ]);
    expect(probe.stderr).toContain("1440x972");
  });

  it("each mark saves a full-size Proof screenshot next to the video", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
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
    await wait(2000);
    await runCli(env, ["mark", id, "step 2: close the menu"]);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await wait(2000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const out = join(dir, "proof.mp4");
    const shot1 = join(dir, "proof-1.png");
    const shot2 = join(dir, "proof-2.png");
    expect(result.stdout).toBe(`${out}\n${shot1}\n${shot2}\n`);
    for (const path of [shot1, shot2]) {
      const png = readFileSync(path);
      expect(png.readUInt32BE(16)).toBe(1440);
      expect(png.readUInt32BE(20)).toBe(900);
    }
    expect(
      Buffer.compare(readFileSync(shot1), readFileSync(shot2)),
    ).not.toBe(0);
  });

  it(
    "a 3-minute Recording with long pauses comes out under 30 s",
    { timeout: 420_000 },
    async () => {
      // Given
      const env = makeEnv({ docker: true });
      const created = await create(env);
      const id = created.stdout.trim();
      const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
      await runCli(env, ["record", "start", id]);
      const actions = [
        ["click", id, "720", "450", "--button", "right", "--pace", "fast"],
        ["key", id, "Escape", "--pace", "fast"],
        ["click", id, "720", "450", "--button", "right", "--pace", "fast"],
      ];
      for (const [index, action] of actions.entries()) {
        await runCli(env, ["mark", id, `step ${index + 1}`]);
        await runCli(env, action);
        await wait(55_000);
      }
      // When
      const result = await runCli(env, [
        "record",
        "stop",
        id,
        "--out",
        join(dir, "proof.mp4"),
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      const probe = await runCli(env, [
        "exec",
        id,
        "--",
        "/opt/proofbox/tools/ffmpeg",
        "-hide_banner",
        "-i",
        "/run/proofbox/recordings/1/proof.mp4",
      ]);
      const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr);
      const seconds =
        Number(duration?.[1]) * 3600 +
        Number(duration?.[2]) * 60 +
        Number(duration?.[3]);
      expect(seconds).toBeLessThan(30);
      expect(seconds).toBeGreaterThanOrEqual(9);
    },
  );

  it(
    "a Proof video over --max-size exits with its size and keeps the raw Recording",
    { timeout: 300_000 },
    async () => {
      // Given
      const env = makeEnv({ docker: true });
      const created = await create(env);
      const id = created.stdout.trim();
      const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
      const noise = await startNoise(env, id);
      expect(noise.exitCode).toBe(0);
      await runCli(env, ["record", "start", id]);
      await wait(10_000);
      // When
      const result = await runCli(env, [
        "record",
        "stop",
        id,
        "--out",
        join(dir, "big.mp4"),
        "--max-size",
        "1MB",
      ]);
      // Then
      expect(result.exitCode).toBe(125);
      expect(
        result.stderr.match(/trying lower quality/g),
      ).toHaveLength(2);
      expect(result.stderr).toMatch(
        /Proof video is \d+\.\d MB at the lowest quality, over the 1\.0 MB Size limit/,
      );
      expect(existsSync(join(dir, "big.mp4"))).toBe(false);
      const raw = await runCli(env, [
        "exec",
        id,
        "--",
        "test",
        "-s",
        "/run/proofbox/recordings/1/raw.mkv",
      ]);
      expect(raw.exitCode).toBe(0);
    },
  );
});
