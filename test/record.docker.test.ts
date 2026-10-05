import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLogLine } from "../src/pixel.ts";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { startFlicker, startNoise } from "./support/noise.ts";

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
    expect(result.exitCode, result.stderr).toBe(0);
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
    expect(result.exitCode, result.stderr).toBe(0);
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
    expect(result.exitCode, result.stderr).toBe(0);
    const out = join(dir, "proof.mp4");
    const shot1 = join(dir, "proof-1.png");
    const shot2 = join(dir, "proof-2.png");
    expect(result.stdout).toBe(`${out}\n${shot1}\n${shot2}\n`);
    for (const path of [shot1, shot2]) {
      const png = readFileSync(path);
      expect(png.readUInt32BE(16)).toBe(1440);
      expect(png.readUInt32BE(20)).toBe(900);
    }
    expect(Buffer.compare(readFileSync(shot1), readFileSync(shot2))).not.toBe(
      0,
    );
  });

  it("a 3-minute Recording with long pauses comes out under 30 s", {
    timeout: 420_000,
  }, async () => {
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
    expect(result.exitCode, result.stderr).toBe(0);
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
  });

  it("a Proof video over --max-size exits with its size and keeps the raw Recording", {
    timeout: 300_000,
  }, async () => {
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
    expect(result.stderr.match(/trying lower quality/g)).toHaveLength(2);
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
  });

  it("record stop --discard downloads nothing and keeps the raw Recording and the Action log", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
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
    // When
    const result = await runCli(env, ["record", "stop", id, "--discard"]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "proofbox: discarded the Recording; nothing was downloaded. The raw Recording stays at /run/proofbox/recordings/1/raw.mkv\n",
    );
    expect(readdirSync(dir)).toEqual([]);
    const raw = await runCli(env, [
      "exec",
      id,
      "--",
      "test",
      "-s",
      "/run/proofbox/recordings/1/raw.mkv",
    ]);
    expect(raw.exitCode).toBe(0);
    const log = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/action-log.jsonl",
    ]);
    expect(log.stdout).toContain('"kind":"click"');
  });

  it("a Still part that a click ends has no label in the Proof video", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await wait(6000);
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
    await wait(1000);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await wait(1000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    const edit = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/recordings/1/edit.txt",
    ]);
    expect(edit.stdout).not.toContain("later");
  });

  it("a Still part that exec ends keeps its label in the Proof video", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await wait(6000);
    // DISPLAY=:99 comes from images/linux/Dockerfile.
    await runCli(env, [
      "exec",
      id,
      "--",
      "xdotool",
      "mousemove",
      "720",
      "450",
      "click",
      "3",
    ]);
    await wait(1000);
    await runCli(env, ["exec", id, "--", "xdotool", "key", "Escape"]);
    await wait(1000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    const edit = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/recordings/1/edit.txt",
    ]);
    expect(edit.stdout).toMatch(/:text=» \d+ s later:expansion=none:/);
  });

  it("a Wait mark puts its reason on the label in the Proof video", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await wait(6000);
    await runCli(env, ["mark", id, "waiting for the menu", "--wait"]);
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
    await wait(1000);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await wait(1000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    const edit = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/recordings/1/edit.txt",
    ]);
    expect(edit.stdout).toMatch(
      /:text=» \d+ s later · waiting for the menu:expansion=none:/,
    );
  });

  it("record stop warns about a Wait mark that found no Still part", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    const flicker = await startFlicker(env, id);
    expect(flicker.exitCode).toBe(0);
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await wait(1000);
    const marked = await runCli(env, [
      "mark",
      id,
      "nobody waits here",
      "--wait",
    ]);
    expect(marked.exitCode, marked.stderr).toBe(0);
    // The flicker page changes the screen every frame, so step 1 has no
    // Still part, however slow the calls are.
    await runCli(env, ["mark", id, "step 2: done"]);
    await wait(1000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'proofbox: Wait mark "nobody waits here" found no free Still part in step 1\n',
    );
  });

  it("record stop names a Wait mark before the first Step mark", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
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
    await wait(1000);
    const marked = await runCli(env, [
      "mark",
      id,
      "nobody waits here",
      "--wait",
    ]);
    expect(marked.exitCode, marked.stderr).toBe(0);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    // When Step marks follow, step 0 keeps no tail Still part, so the
    // still after the click cannot take the Wait mark.
    await runCli(env, ["mark", id, "step 1: done"]);
    await wait(1000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "proof.mp4"),
    ]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'proofbox: Wait mark "nobody waits here" found no free Still part before the first Step mark\n',
    );
  });

  it("record start twice is refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    // When
    const result = await runCli(env, ["record", "start", id]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `A Recording is already running on ${id}; run record stop first\n`,
    );
  });

  it("record stop with no Recording is refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "p.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `No Recording is running on ${id}; run record start first\n`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("mark with no Recording is refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["mark", id, "step 1"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `No Recording is running on ${id}; run record start first\n`,
    );
  });

  it("mark --wait with no Recording is refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, ["mark", id, "waiting", "--wait"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `No Recording is running on ${id}; run record start first\n`,
    );
  });

  it("a Wait mark is in the Action log with its reason", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await runCli(env, ["record", "start", id]);
    await runCli(env, ["exec", id, "--", "xdotool", "mousemove", "720", "450"]);
    const reason = String.raw`it's "quoted" \ done`;
    // When
    const marked = await runCli(env, ["mark", id, reason, "--wait"]);
    // Then
    expect(marked.exitCode, marked.stderr).toBe(0);
    const cat = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/action-log.jsonl",
    ]);
    const last = cat.stdout.trim().split("\n").at(-1) ?? "";
    const { t: _t, ...rest } = Schema.decodeUnknownSync(
      Schema.parseJson(ActionLogLine),
    )(last);
    expect(rest).toEqual({ kind: "wait", x: 720, y: 450, reason });
  });

  it("a Step mark's time is on the Sandbox's uptime clock", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await runCli(env, ["record", "start", id]);
    const uptime = async () =>
      Number(
        (
          await runCli(env, [
            "exec",
            id,
            "--",
            "cut",
            "-d",
            " ",
            "-f1",
            "/proc/uptime",
          ])
        ).stdout,
      );
    const before = await uptime();
    // When
    const marked = await runCli(env, ["mark", id, "step 1: look"]);
    const after = await uptime();
    // Then
    expect(marked.exitCode, marked.stderr).toBe(0);
    const cat = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/action-log.jsonl",
    ]);
    const last = Schema.decodeUnknownSync(Schema.parseJson(ActionLogLine))(
      cat.stdout.trim().split("\n").at(-1) ?? "",
    );
    expect(last.kind).toBe("mark");
    expect(last.t).toBeGreaterThanOrEqual(before - 0.01);
    expect(last.t).toBeLessThanOrEqual(after + 0.01);
  });

  it("a Wait mark starts no step and saves no Proof screenshot", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    const out = join(dir, "proof.mp4");
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
    await wait(500);
    await runCli(env, ["mark", id, "waiting for the menu", "--wait"]);
    await wait(2000);
    // When
    const result = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${out}\n${join(dir, "proof-1.png")}\n`);
  });

  it("a Recording where nothing changed on screen makes no video", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await wait(6000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "still.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "proofbox: building the Proof video\n" +
        `Recording on ${id}: nothing changed on screen, so no Proof video was made. The raw Recording stays at /run/proofbox/recordings/1/raw.mkv; check the app is on screen and record again.\n`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a Recording under 3 s where nothing changed is still refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
    await wait(2000);
    // When
    const result = await runCli(env, [
      "record",
      "stop",
      id,
      "--out",
      join(dir, "still.mp4"),
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "proofbox: building the Proof video\n" +
        `Recording on ${id}: nothing changed on screen, so no Proof video was made. The raw Recording stays at /run/proofbox/recordings/1/raw.mkv; check the app is on screen and record again.\n`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("record stop prints progress on stderr while it builds", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
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
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      result.stderr.startsWith("proofbox: building the Proof video\n"),
    ).toBe(true);
    expect(result.stdout).toBe(`${join(dir, "proof.mp4")}\n`);
  });

  it("record stop --out into a missing folder says it could not write the file", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-rec-"));
    await runCli(env, ["record", "start", id]);
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
    const out = join(dir, "missing", "proof.mp4");
    const result = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(125);
    const lines = result.stderr.split("\n").filter((line) => line !== "");
    const last = lines[lines.length - 1] ?? "";
    expect(last.startsWith(`Could not write ${out}: `)).toBe(true);
    expect(last.endsWith(". Check the folder exists and try again.")).toBe(
      true,
    );
    for (const line of lines) {
      expect(line.includes("Error:")).toBe(false);
      expect(line.startsWith("    at ")).toBe(false);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
