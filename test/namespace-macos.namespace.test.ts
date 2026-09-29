import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { openEventsPage, readEvents } from "./support/events.ts";

// Real Namespace Macs cost money and the workspace quota holds one 6x14 Mac
// at a time, so each describe makes one Mac, shares it, and deletes it.

const nscBin = () => process.env.PROOFBOX_NSC ?? "nsc";

const destroy = (id: string): Promise<void> =>
  new Promise((resolve) => {
    execFile(nscBin(), ["destroy", id, "--force"], () => resolve());
  });

const createMac = async (env: CliEnv, extra: ReadonlyArray<string> = []) => {
  const result = await runCli(env, [
    "create",
    "--os",
    "macos",
    "--provider",
    "namespace",
    ...extra,
  ]);
  return { result, id: result.stdout.trim() };
};

describe("Namespace macOS Provider", () => {
  let env: CliEnv;
  let created: Awaited<ReturnType<typeof createMac>>;
  let id: string;

  beforeAll(async () => {
    env = makeEnv({ namespace: true });
    created = await createMac(env);
    id = created.id;
  });

  afterAll(async () => {
    if (/^ns:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroy(id.slice("ns:".length));
    }
    cleanupEnvs();
  });

  it("create --os macos prints an ns id for a prepared macOS 26 Mac", async () => {
    // Given: the Mac from beforeAll
    // When
    const version = await runCli(env, [
      "exec",
      id,
      "--",
      "sw_vers",
      "-productVersion",
    ]);
    // Then
    expect(created.result.stdout).toMatch(/^ns:[a-z0-9]+\n$/);
    expect(created.result.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^26\./);
  });

  it("the Tool bundle on the Mac has the pinned hashes", async () => {
    // Given: the Mac from beforeAll
    // When
    const sums = await runCli(env, [
      "exec",
      id,
      "--",
      "shasum",
      "-a",
      "256",
      "/opt/proofbox/tools/ffmpeg",
    ]);
    // Then
    expect(sums.stdout).toBe(
      "2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384  /opt/proofbox/tools/ffmpeg\n",
    );
  });

  it("the workload token and the Docker config are gone", async () => {
    // Given: the Mac from beforeAll
    // When
    const found = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "test -e /var/run/nsc/token.json || test -e /Users/runner/.docker/config.json",
    ]);
    // Then
    expect(found.exitCode).toBe(1);
  });

  it("the memory watcher runs after create", async () => {
    // Given: the Mac from beforeAll
    // When
    const found = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'ps -p "$(cat /var/run/proofbox-memory-watch.pid)" -o command=',
    ]);
    // Then
    expect(found.stdout).toMatch(/^\/usr\/bin\/log stream /);
  });

  it("live on a Mac is refused until #15", async () => {
    // Given: the Mac from beforeAll
    // When
    const live = await runCli(env, ["live", id]);
    // Then
    expect(live.stderr).toBe(
      "Provider namespace lacks the Capability live-view on macos; no Live view was opened\n",
    );
    expect(live.exitCode).toBe(125);
  });

  it("screenshot --out writes a 2560x1600 PNG", async () => {
    // Given: the Mac from beforeAll
    const out = join(mkdtempSync(join(tmpdir(), "proofbox-shot-")), "shot.png");
    // When
    const result = await runCli(env, ["screenshot", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(0);
    const bytes = readFileSync(out);
    expect(bytes.readUInt32BE(16)).toBe(2560);
    expect(bytes.readUInt32BE(20)).toBe(1600);
  });

  it("a point outside 1280x800 is refused", async () => {
    // Given: the Mac from beforeAll
    // When
    const result = await runCli(env, ["click", id, "1280", "10"]);
    // Then
    expect(result.stderr).toBe(
      "Point 1280,10 is outside the screen (1280x800); use x 0 to 1279 and y 0 to 799\n",
    );
    expect(result.exitCode).toBe(125);
  });

  describe("on the events page", () => {
    beforeAll(async () => {
      await openEventsPage(env, id);
    });

    it("click glides at human pace and lands on the point", async () => {
      // Given: the events page open
      const started = Date.now();
      // When
      const result = await runCli(env, ["click", id, "640", "400"]);
      // Then
      const elapsed = Date.now() - started;
      expect(result.exitCode).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(1100);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({
        type: "mousedown",
        x: 640,
        y: 400,
        button: 0,
      });
      expect(events).toContainEqual({
        type: "mouseup",
        x: 640,
        y: 400,
        button: 0,
      });
    });

    it("type enters the text", async () => {
      // Given: the input focused
      await runCli(env, ["click", id, "640", "400", "--pace", "fast"]);
      // When
      const result = await runCli(env, ["type", id, "hello mac"]);
      // Then
      expect(result.exitCode).toBe(0);
      const inputs = (await readEvents(env, id)).filter(
        (event) => event.type === "input",
      );
      expect(inputs.at(-1)).toEqual({ type: "input", value: "hello mac" });
    });

    it("key sends a combo and a named key", async () => {
      // Given: the input focused
      // When
      const combo = await runCli(env, ["key", id, "ctrl+a"]);
      const named = await runCli(env, ["key", id, "Return"]);
      // Then
      expect(combo.exitCode).toBe(0);
      expect(named.exitCode).toBe(0);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({
        type: "keydown",
        key: "a",
        ctrl: true,
        meta: false,
      });
      expect(events).toContainEqual({
        type: "keydown",
        key: "Enter",
        ctrl: false,
        meta: false,
      });
    });

    it("key sends xdotool punctuation names", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, ["key", id, "ctrl+equal comma"]);
      // Then
      expect(result.exitCode).toBe(0);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({
        type: "keydown",
        key: "=",
        ctrl: true,
        meta: false,
      });
      expect(events).toContainEqual({
        type: "keydown",
        key: ",",
        ctrl: false,
        meta: false,
      });
    });

    it("scroll sends wheel steps down and up", async () => {
      // Given: the events page open
      // When
      const down = await runCli(env, ["scroll", id, "640", "400", "down", "3"]);
      const up = await runCli(env, ["scroll", id, "640", "400", "up", "3"]);
      // Then
      expect(down.exitCode).toBe(0);
      expect(up.exitCode).toBe(0);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({ type: "wheel", dir: "down" });
      expect(events).toContainEqual({ type: "wheel", dir: "up" });
    });

    it("drag presses at the start and releases at the end", async () => {
      // Given: the events page open
      // When
      const result = await runCli(env, [
        "drag",
        id,
        "200",
        "200",
        "600",
        "400",
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({
        type: "mousedown",
        x: 200,
        y: 200,
        button: 0,
      });
      expect(events).toContainEqual({
        type: "mouseup",
        x: 600,
        y: 400,
        button: 0,
      });
    });
  });
});

describe("Namespace macOS Recording", () => {
  let env: CliEnv;
  let created: Awaited<ReturnType<typeof createMac>>;
  let id: string;

  beforeAll(async () => {
    env = makeEnv({ namespace: true });
    created = await createMac(env);
    id = created.id;
  });

  afterAll(async () => {
    if (/^ns:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroy(id.slice("ns:".length));
    }
    cleanupEnvs();
  });

  const ffmpeg = (argv: string[]): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      execFile("ffmpeg", argv, { encoding: "buffer" }, (error, stdout) =>
        error === null ? resolve(stdout) : reject(error),
      );
    });

  const grayRow = async (file: string, y: number): Promise<Buffer> =>
    ffmpeg([
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `crop=1440:1:0:${y},format=gray`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ]);

  it("record stop on a Mac downloads an H.264 MP4 with the index first", async () => {
    // Given: the Mac from beforeAll
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    // When
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await runCli(env, [
      "click",
      id,
      "640",
      "400",
      "--button",
      "right",
      "--pace",
      "fast",
    ]);
    await setTimeout(2000);
    await runCli(env, ["mark", id, "step 2: close the menu"]);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await setTimeout(2000);
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout.split("\n")[0]).toBe(out);
    const bytes = readFileSync(out);
    expect(bytes.subarray(4, 8).toString("utf8")).toBe("ftyp");
    const moov = bytes.indexOf("moov");
    expect(moov).toBeGreaterThan(-1);
    expect(moov).toBeLessThan(bytes.indexOf("mdat"));
    const probe = await runCli(env, [
      "exec",
      id,
      "--",
      "/opt/proofbox/tools/ffmpeg",
      "-hide_banner",
      "-i",
      "/var/lib/proofbox/recordings/1/proof.mp4",
    ]);
    expect(probe.stderr).toContain("h264 (High)");
    expect(probe.stderr).toContain("yuv420p");
  });

  it("a Mac Proof video is 1440x972 with a caption bar", async () => {
    // Given: the Mac from beforeAll
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    // When
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await runCli(env, [
      "click",
      id,
      "640",
      "400",
      "--button",
      "right",
      "--pace",
      "fast",
    ]);
    await setTimeout(2000);
    await runCli(env, ["mark", id, "step 2: close the menu"]);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await setTimeout(2000);
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(stopped.exitCode).toBe(0);
    const frame = await ffmpeg([
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      out,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ]);
    expect(frame.readUInt32BE(16)).toBe(1440);
    expect(frame.readUInt32BE(20)).toBe(972);
    const probe = await runCli(env, [
      "exec",
      id,
      "--",
      "/opt/proofbox/tools/ffmpeg",
      "-hide_banner",
      "-i",
      "/var/lib/proofbox/recordings/2/proof.mp4",
    ]);
    expect(probe.stderr).toContain("1440x972");
    expect(probe.stderr).toContain("yuv420p");
    // The caption bar is the top 72 pixels: a row in it is dark, a row in
    // the picture is not.
    const bar = await grayRow(out, 36);
    const picture = await grayRow(out, 500);
    expect(Math.max(...bar)).toBeLessThan(64);
    expect(Math.max(...picture)).toBeGreaterThanOrEqual(64);
  });

  it("each mark on a Mac saves a 2560x1600 Proof screenshot", async () => {
    // Given: the Mac from beforeAll
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    // When
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await setTimeout(1000);
    await runCli(env, ["mark", id, "step 1: look"]);
    await setTimeout(1000);
    await runCli(env, [
      "click",
      id,
      "640",
      "400",
      "--button",
      "right",
      "--pace",
      "fast",
    ]);
    await runCli(env, ["mark", id, "step 2: look"]);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await setTimeout(1000);
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(stopped.exitCode).toBe(0);
    const first = `${dir}/proof-1.png`;
    const second = `${dir}/proof-2.png`;
    expect(stopped.stdout).toBe(`${out}\n${first}\n${second}\n`);
    for (const file of [first, second]) {
      const bytes = readFileSync(file);
      expect(bytes.readUInt32BE(16)).toBe(2560);
      expect(bytes.readUInt32BE(20)).toBe(1600);
    }
    expect(readFileSync(first).equals(readFileSync(second))).toBe(false);
  });

  it("a click on a Mac goes into the Action log in points", async () => {
    // Given: the Mac from beforeAll
    // When
    const clicked = await runCli(env, [
      "click",
      id,
      "640",
      "400",
      "--pace",
      "fast",
    ]);
    expect(clicked.exitCode).toBe(0);
    const tail = await runCli(env, [
      "exec",
      id,
      "--",
      "tail",
      "-n",
      "1",
      "/var/lib/proofbox/action-log.jsonl",
    ]);
    // Then
    const entry = JSON.parse(tail.stdout.trim()) as {
      kind: string;
      x: number;
      y: number;
    };
    expect(entry.kind).toBe("click");
    expect(entry.x).toBe(640);
    expect(entry.y).toBe(400);
  });

  it("a 60 s Recording on a Mac runs at real speed with no drops", async () => {
    // Given: the Mac from beforeAll
    // When
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await setTimeout(60_000);
    const stopped = await runCli(env, ["record", "stop", id, "--discard"]);
    // Then
    expect(stopped.exitCode).toBe(0);
    const last = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "tr '\\r' '\\n' < /var/lib/proofbox/recordings/4/ffmpeg.log | grep 'speed=' | tail -n 1",
    ]);
    expect(last.stdout).toContain("drop=0");
    const speed = /speed=\s*([\d.]+)x/.exec(last.stdout)?.[1];
    expect(speed).toBeDefined();
    expect(Number(speed)).toBeGreaterThanOrEqual(0.98);
    expect(Number(speed)).toBeLessThanOrEqual(1.02);
  });

  it("record stop names a capture that stopped during the walk", async () => {
    // Given: a Recording on the Mac of the describe
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await setTimeout(2000);
    await runCli(env, ["exec", id, "--", "pkill", "-9", "-x", "ffmpeg"]);
    // When
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    const blocked = join(dir, "proof-blocked.png");
    expect(stopped.exitCode).toBe(125);
    expect(stopped.stderr).toBe(
      `Recording on ${id} failed: the capture stopped, so no Proof video was made. Saved the screen to ${blocked}. Record the walk again.\n`,
    );
    expect(readFileSync(blocked).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("record stop names a stalled capture", async () => {
    // Given: a Recording on the Mac of the describe
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await setTimeout(2000);
    await runCli(env, ["exec", id, "--", "pkill", "-STOP", "-x", "ffmpeg"]);
    await setTimeout(8000);
    // When
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(stopped.exitCode).toBe(125);
    expect(
      stopped.stderr.startsWith(
        `Recording on ${id} failed: the capture stalled, so no Proof video was made.`,
      ),
    ).toBe(true);
  });

  it("record stop names an alert on screen", async () => {
    // Given: a Recording on the Mac of the describe
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    const replayd =
      "/Users/runner/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist";
    const hint = "/opt/namespace/vmguest.kScreenCapturePrivacyHintDate";
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await setTimeout(2000);
    try {
      await runCli(env, [
        "exec",
        id,
        "--",
        "plutil",
        "-replace",
        hint,
        "-date",
        "2026-01-01T00:00:00Z",
        replayd,
      ]);
      // When
      const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
      // Then
      expect(stopped.exitCode).toBe(125);
      expect(
        stopped.stderr.startsWith(
          `Recording on ${id} failed: an alert is on screen, so no Proof video was made.`,
        ),
      ).toBe(true);
    } finally {
      await runCli(env, [
        "exec",
        id,
        "--",
        "plutil",
        "-replace",
        hint,
        "-date",
        "4000-01-01T00:00:00Z",
        replayd,
      ]);
    }
  });
});

describe("Namespace macOS Secrets", () => {
  let env: CliEnv;
  let id: string;

  beforeAll(async () => {
    env = makeEnv({ namespace: true });
    const folder = mkdtempSync(join(tmpdir(), "proofbox-work-"));
    execFileSync("git", ["init", "-q"], { cwd: folder });
    const scriptDir = mkdtempSync(join(tmpdir(), "proofbox-setup-"));
    const script = join(scriptDir, "setup.sh");
    writeFileSync(script, "#!/bin/sh\nenv > setup-env.txt\n", {
      mode: 0o755,
    });
    const envDir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
    const file = join(envDir, "app.env");
    writeFileSync(file, "API_TOKEN=pb-secret-7f3a91\n", { mode: 0o600 });
    const created = await createMac(env, [
      "--work",
      folder,
      "--setup",
      script,
      "--env-file",
      file,
    ]);
    id = created.id;
    expect(created.result.exitCode).toBe(0);
  });

  afterAll(async () => {
    if (/^ns:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroy(id.slice("ns:".length));
    }
    cleanupEnvs();
  });

  it("a command after create --env-file on a Mac sees the Secret", async () => {
    // Given: the describe's Mac
    // When
    const seen = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'printf %s "$API_TOKEN"',
    ]);
    // Then
    expect(seen.stdout).toBe("pb-secret-7f3a91");
  });

  it("the Setup script on a Mac runs without the Secret", async () => {
    // Given: the describe's Mac
    // When
    const seen = await runCli(env, ["exec", id, "--", "cat", "setup-env.txt"]);
    // Then
    expect(seen.exitCode).toBe(0);
    expect(seen.stdout).not.toContain("API_TOKEN");
  });

  it("the Secrets on a Mac are runner's alone", async () => {
    // Given: the describe's Mac
    // When
    const seen = await runCli(env, [
      "exec",
      id,
      "--",
      "stat",
      "-f",
      "%Su %Lp",
      "/var/run/proofbox-secrets",
      "/var/run/proofbox-secrets/env",
    ]);
    // Then
    expect(seen.stdout).toBe("runner 700\nrunner 600\n");
  });

  it("the Secrets on a Mac sit only on the RAM disk", async () => {
    // Given: the describe's Mac
    // When
    const seen = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "mount; sudo -n grep -rl pb-secret-7f3a91 /Users/runner /var/lib/proofbox /private/tmp /var/log 2>/dev/null; true",
    ]);
    // Then
    expect(seen.stdout).toContain(
      "/private/var/run/proofbox-secrets (hfs, local, nodev, nosuid",
    );
    expect(seen.stdout).not.toContain("pb-secret-7f3a91");
  });
});

describe("Namespace macOS Provider at 6x14", () => {
  it("create --os macos --size 6x14 makes a 6-CPU Mac", async () => {
    // Given: no other Mac is up (the quota holds one 6x14 Mac)
    const env = makeEnv({ namespace: true });
    try {
      // When
      const { result, id } = await createMac(env, ["--size", "6x14"]);
      try {
        const cpus = await runCli(env, [
          "exec",
          id,
          "--",
          "sysctl",
          "-n",
          "hw.ncpu",
        ]);
        // Then
        expect(result.exitCode).toBe(0);
        expect(cpus.stdout).toBe("6\n");
      } finally {
        if (/^ns:[a-z0-9]+$/.test(id)) {
          await runCli(env, ["delete", id]);
          await destroy(id.slice("ns:".length));
        }
      }
    } finally {
      cleanupEnvs();
    }
  });
});
