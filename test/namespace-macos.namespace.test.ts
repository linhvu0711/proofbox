import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import {
  openEventsPage,
  readEvents,
  readHeldModifiers,
} from "./support/events.ts";
import { destroyHost, liveInstances } from "./support/namespace-live.ts";
import { findColor } from "./support/png.ts";

// Real Namespace Macs cost money and the workspace quota holds one 6x14 Mac
// at a time, so each describe makes one Mac, shares it, and deletes it.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

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
    if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroyHost(id.split(":").at(-2) ?? "", id.split(":").at(-1) ?? "");
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
    expect(created.result.stdout).toMatch(/^ns:[a-z0-9]+:[a-z0-9]+\n$/);
    expect(created.result.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^26\./);
  });

  it("a warm exec takes under 2 s", async () => {
    // Given: the Mac from beforeAll, its Keeper holding the link
    const cold = await runCli(env, ["exec", id, "--", "true"]);
    // When
    const start = performance.now();
    const warm = await runCli(env, ["exec", id, "--", "true"]);
    const millis = performance.now() - start;
    // Then
    expect(cold.exitCode).toBe(0);
    expect(warm.exitCode).toBe(0);
    expect(millis).toBeLessThan(2000);
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

  it("live on a Mac prints a local address that offers VNC password login", async () => {
    // Given: the Mac from beforeAll
    // When: `live` as a child; read its first two stdout lines
    const child = spawn(process.execPath, ["src/main.ts", "live", id], {
      cwd: repoRoot,
      env: { ...process.env, ...env.env },
    });
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
      expect(passwordLine).toMatch(/^password [A-Za-z0-9]{8}$/);
      port = Number(address.split(":")[1]);
      const greeting = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("data", (data) => {
          resolve(data);
        });
        socket.once("error", reject);
      });
      expect(greeting.subarray(0, 8).toString("utf8")).toBe("RFB 003.");
      // Answer the handshake and read the security types: 2 is VNC login
      const types = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("data", () => {
          socket.write("RFB 003.008\n");
        });
        socket.on("data", (data) => {
          if (!data.subarray(0, 8).toString("utf8").startsWith("RFB")) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.once("error", reject);
      });
      expect([...types.subarray(1)]).toContain(2);
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
    // And closing the last live session turns VNC back off on the Mac
    const off = await runCli(env, [
      "exec",
      id,
      "--",
      "sudo",
      "-n",
      "sh",
      "-c",
      "test ! -s /var/db/proofbox-live/.password && ! pgrep -f ARDAgent >/dev/null",
    ]);
    expect(off.exitCode).toBe(0);
  });

  it("a Mac with live running has only a private address and no ingress", async () => {
    // Given: the Mac from beforeAll with `live` running
    const host = id.split(":").at(-1) ?? "";
    const child = spawn(process.execPath, ["src/main.ts", "live", id], {
      cwd: repoRoot,
      env: { ...process.env, ...env.env },
    });
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
      const entry = (await liveInstances()).find((item) => item.id === host);
      const net = await runCli(env, ["exec", id, "--", "ifconfig"]);
      const addresses = [...net.stdout.matchAll(/inet (\d+\.\d+\.\d+\.\d+)/g)]
        .map((match) => match[1] as string)
        .filter((address) => address !== "127.0.0.1");
      // Then
      expect(entry === undefined || !("ingress" in entry)).toBe(true);
      const isPrivate = (address: string) =>
        address.startsWith("10.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(address) ||
        address.startsWith("192.168.");
      expect(addresses.length).toBeGreaterThan(0);
      for (const address of addresses) {
        expect(isPrivate(address)).toBe(true);
      }
    } finally {
      child.kill("SIGINT");
    }
  });

  it("screenshot --out writes a 1280x800 PNG", async () => {
    // Given: the Mac from beforeAll
    const out = join(mkdtempSync(join(tmpdir(), "proofbox-shot-")), "shot.png");
    // When
    const result = await runCli(env, ["screenshot", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(0);
    const bytes = readFileSync(out);
    expect(bytes.readUInt32BE(16)).toBe(1280);
    expect(bytes.readUInt32BE(20)).toBe(800);
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

    it("type after a cmd combo enters the text", async () => {
      // Given: the input focused
      await runCli(env, ["click", id, "640", "400", "--pace", "fast"]);
      // When
      await runCli(env, ["key", id, "cmd+a"]);
      const result = await runCli(env, ["type", id, "after"]);
      // Then
      expect(result.exitCode).toBe(0);
      const inputs = (await readEvents(env, id)).filter(
        (event) => event.type === "input",
      );
      expect(inputs.at(-1)).toEqual({ type: "input", value: "after" });
    });

    it("key leaves no modifier held", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, [
        "key",
        id,
        "cmd+a ctrl+a shift+End alt+Left",
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      expect(await readHeldModifiers(env, id)).toBe("none");
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

    it("key sends a lone modifier and a shifted symbol", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, ["key", id, "shift ctrl+plus"]);
      // Then
      expect(result.exitCode).toBe(0);
      // Chrome on a Mac names Control+Shift+Equal "=", as a real keyboard
      // does, so the Shift keydown inside the combo is what shows "plus".
      const keydowns = (await readEvents(env, id)).filter(
        (event) => event.type === "keydown",
      );
      expect(keydowns.slice(-4)).toEqual([
        { type: "keydown", key: "Shift", ctrl: false, meta: false },
        { type: "keydown", key: "Control", ctrl: true, meta: false },
        { type: "keydown", key: "Shift", ctrl: true, meta: false },
        { type: "keydown", key: "=", ctrl: true, meta: false },
      ]);
      expect(await readHeldModifiers(env, id)).toBe("none");
    });

    it("key takes every xdotool modifier name alone", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, [
        "key",
        id,
        "Shift_L Shift_R Control_L Control_R Alt_L Alt_R Super_L Super_R Meta_L Meta_R shift ctrl control alt option cmd super meta",
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      expect(await readHeldModifiers(env, id)).toBe("none");
    });

    it("key sends every US shifted-symbol name", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, [
        "key",
        id,
        "plus exclam at numbersign dollar percent asciicircum ampersand asterisk parenleft parenright underscore colon quotedbl less greater question braceleft braceright bar asciitilde",
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      const events = await readEvents(env, id);
      for (const key of '+!@#$%^&*()_:"<>?{}|~') {
        expect(events).toContainEqual({
          type: "keydown",
          key,
          ctrl: false,
          meta: false,
        });
      }
    });

    it("key refuses an unknown key name", async () => {
      // Given: the input focused
      // When
      const result = await runCli(env, ["key", id, "nosuchkey"]);
      // Then
      expect(result.stderr).toContain("input: unknown key nosuchkey");
      expect(result.exitCode).toBe(125);
    });

    it("click --screenshot writes a 1280x800 PNG", async () => {
      // Given: the events page open
      const out = join(
        mkdtempSync(join(tmpdir(), "proofbox-shot-")),
        "shot.png",
      );
      // When
      const result = await runCli(env, [
        "click",
        id,
        "640",
        "400",
        "--pace",
        "fast",
        "--screenshot",
        out,
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      const bytes = readFileSync(out);
      expect(bytes.readUInt32BE(16)).toBe(1280);
      expect(bytes.readUInt32BE(20)).toBe(800);
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

    it("a marker found in the screenshot's pixels is where click lands", async () => {
      // Given: the events page open (with the marker)
      const out = join(
        mkdtempSync(join(tmpdir(), "proofbox-shot-")),
        "shot.png",
      );
      const shot = await runCli(env, ["screenshot", id, "--out", out]);
      expect(shot.exitCode).toBe(0);
      const at = findColor(
        readFileSync(out),
        (r, g, b) => r > 200 && g < 80 && b > 200,
      );
      expect(at).toBeDefined();
      if (at === undefined) {
        throw new Error("no marker in the screenshot");
      }
      // When
      const result = await runCli(env, [
        "click",
        id,
        String(at.x),
        String(at.y),
        "--pace",
        "fast",
      ]);
      // Then
      expect(result.exitCode).toBe(0);
      const events = await readEvents(env, id);
      expect(events).toContainEqual({ type: "marker" });
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
    if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroyHost(id.split(":").at(-2) ?? "", id.split(":").at(-1) ?? "");
    }
    cleanupEnvs();
  });

  const ffmpeg = (argv: string[]): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        argv,
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      );
    });

  const grayRow = async (file: string, y: number): Promise<Buffer> =>
    ffmpeg([
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `crop=1440:2:0:${y},format=gray`,
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
    // avfoundation prints no drop= counter; the frame count is the proof:
    // 1868 frames over 62.26 s at 30 fps is every frame, no drops.
    const frames = /frame=\s*(\d+)/.exec(last.stdout)?.[1];
    const at = /time=(\d+):(\d+):([\d.]+)/.exec(last.stdout);
    expect(frames).toBeDefined();
    expect(at).not.toBeNull();
    const [h, m, s] = (at as RegExpExecArray).slice(1).map(Number);
    const elapsed = (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
    expect(Number(frames)).toBeGreaterThanOrEqual(
      Math.floor(elapsed * 30 * 0.98),
    );
    expect(last.stdout).not.toMatch(/drop=[1-9]/);
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

  it("a Wait mark on a Mac puts its reason on the label", async () => {
    // Given: the Mac from beforeAll; last so the recordings/<n> probes in
    // the earlier tests keep their numbers.
    const dir = mkdtempSync(join(tmpdir(), "proofbox-proof-"));
    const out = join(dir, "proof.mp4");
    // When
    const started = await runCli(env, ["record", "start", id]);
    expect(started.exitCode).toBe(0);
    await runCli(env, ["mark", id, "step 1: open the menu"]);
    await setTimeout(6000);
    await runCli(env, ["mark", id, "waiting for the menu", "--wait"]);
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
    await setTimeout(1000);
    await runCli(env, ["key", id, "Escape", "--pace", "fast"]);
    await setTimeout(1000);
    const stopped = await runCli(env, ["record", "stop", id, "--out", out]);
    // Then
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    const edit = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'cat "$(ls -dt /var/lib/proofbox/recordings/[0-9]*/ | head -n 1)edit.txt"',
    ]);
    expect(edit.stdout).toMatch(
      /:text=» \d+ s later · waiting for the menu:expansion=none:/,
    );
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
    if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroyHost(id.split(":").at(-2) ?? "", id.split(":").at(-1) ?? "");
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
        if (/^ns:[a-z0-9]+:[a-z0-9]+$/.test(id)) {
          await runCli(env, ["delete", id]);
          await destroyHost(
            id.split(":").at(-2) ?? "",
            id.split(":").at(-1) ?? "",
          );
        }
      }
    } finally {
      cleanupEnvs();
    }
  });
});
