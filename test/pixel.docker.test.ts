import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLogLine } from "../src/pixel.ts";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { readXev, startXev, type XevEvent } from "./support/xev.ts";

const LETTERS_59 =
  "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0123456";

// The KeyPress events after the first click, and the mean X server time in
// ms from one to the next.
const letterGap = (events: ReadonlyArray<XevEvent>) => {
  const clickAt = events.findIndex((event) => event.type === "ButtonPress");
  const keys = events
    .slice(clickAt + 1)
    .filter((event) => event.type === "KeyPress");
  const first = keys[0]?.time ?? 0;
  const last = keys.at(-1)?.time ?? 0;
  return { count: keys.length, gap: (last - first) / (keys.length - 1) };
};

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

describe("Pixel actions", () => {
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

  it("screenshot --out writes a full-size PNG of the desktop", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const out = join(mkdtempSync(join(tmpdir(), "proofbox-shot-")), "shot.png");
    // When
    const result = await runCli(env, ["screenshot", id, "--out", out]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.readUInt32BE(16)).toBe(1440);
    expect(bytes.readUInt32BE(20)).toBe(900);
  });

  it("a frozen screen makes screenshot give up twice with exit 125", async () => {
    // Given: a normal screenshot first, then a frozen X server
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-shot-"));
    const warm = await runCli(env, [
      "screenshot",
      id,
      "--out",
      join(dir, "warm.png"),
    ]);
    expect(warm.stderr).toBe("");
    const container = containerOf(id);
    await docker([
      "exec",
      "-u",
      "root",
      container,
      "pkill",
      "-STOP",
      "-x",
      "Xvfb",
    ]);
    const out = join(dir, "frozen.png");
    try {
      // When
      const result = await runCli(env, ["screenshot", id, "--out", out], {
        set: { PROOFBOX_ANSWER_WAIT: "3s" },
      });
      // Then
      expect({
        exitCode: result.exitCode,
        stderr: result.stderr,
        written: existsSync(out),
      }).toEqual({
        exitCode: 125,
        stderr: `proofbox: the screenshot did not answer in 3 s; trying once more\nSandbox ${id} did not answer the screenshot in 3 s, twice. Try again in a minute. Keeper log: ${env.runtime}/docker-${id.slice("docker:".length)}.log\n`,
        written: false,
      });
    } finally {
      await docker([
        "exec",
        "-u",
        "root",
        container,
        "pkill",
        "-CONT",
        "-x",
        "Xvfb",
      ]);
    }
  });

  it("click presses the left button at the point", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, ["click", id, "700", "400"]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const events = await readXev(env, id);
    const presses = events.filter((event) => event.type === "ButtonPress");
    expect(presses).toEqual([
      { type: "ButtonPress", root: [700, 400], button: 1 },
    ]);
  });

  it("click glides at human pace by default", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const start = Date.now();
    const result = await runCli(env, ["click", id, "100", "100"]);
    const elapsed = Date.now() - start;
    // Then
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    const events = await readXev(env, id);
    const pressAt = events.findIndex((event) => event.type === "ButtonPress");
    const before = pressAt === -1 ? [] : events.slice(0, pressAt);
    expect(
      before.filter((event) => event.type === "MotionNotify").length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("click --pace fast jumps to the point", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, [
      "click",
      id,
      "100",
      "100",
      "--pace",
      "fast",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    const pressAt = events.findIndex((event) => event.type === "ButtonPress");
    const before = pressAt === -1 ? [] : events.slice(0, pressAt);
    expect(
      before.filter((event) => event.type === "MotionNotify").length,
    ).toBeLessThanOrEqual(2);
  });

  it("click --pace fast --screenshot takes under 2 s", async () => {
    // Given: a warm Keeper
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-shot-"));
    await runCli(env, ["screenshot", id, "--out", join(dir, "warm.png")]);
    const out = join(dir, "shot.png");
    // When
    const start = Date.now();
    const result = await runCli(env, [
      "click",
      id,
      "700",
      "400",
      "--pace",
      "fast",
      "--screenshot",
      out,
    ]);
    const elapsed = Date.now() - start;
    // Then
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(2000);
    const bytes = readFileSync(out);
    expect(bytes.readUInt32BE(16)).toBe(1440);
    expect(bytes.readUInt32BE(20)).toBe(900);
  });

  it("a click outside the screen is refused with the screen size", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, ["click", id, "1440", "100"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Point 1440,100 is outside the screen (1440x900); use x 0 to 1439 and y 0 to 899\n",
    );
    const events = await readXev(env, id);
    expect(events.filter((event) => event.type === "ButtonPress")).toHaveLength(
      0,
    );
  });

  it("type sends each letter", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, ["type", id, "hello", "--pace", "fast"]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    const clickAt = events.findIndex((event) => event.type === "ButtonPress");
    const keys = events
      .slice(clickAt + 1)
      .filter((event) => event.type === "KeyPress")
      .map((event) => event.keysym);
    expect(keys).toEqual(["h", "e", "l", "l", "o"]);
  });

  it("type at human pace waits 100 ms between letters", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, ["type", id, LETTERS_59]);
    // Then
    expect(result.exitCode).toBe(0);
    const { count, gap } = letterGap(await readXev(env, id));
    expect(count).toBe(59);
    expect(gap).toBeGreaterThanOrEqual(90);
    expect(gap).toBeLessThanOrEqual(110);
  });

  it("type at --pace fast waits 12 ms between letters", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, [
      "type",
      id,
      LETTERS_59,
      "--pace",
      "fast",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const { count, gap } = letterGap(await readXev(env, id));
    expect(count).toBe(59);
    expect(gap).toBeGreaterThanOrEqual(10.8);
    expect(gap).toBeLessThanOrEqual(13.2);
  });

  it("type with --letter 40ms waits 40 ms between letters", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, [
      "type",
      id,
      LETTERS_59,
      "--pace",
      "fast",
      "--letter",
      "40ms",
      "--type-max",
      "10s",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const { count, gap } = letterGap(await readXev(env, id));
    expect(count).toBe(59);
    expect(gap).toBeGreaterThanOrEqual(36);
    expect(gap).toBeLessThanOrEqual(44);
  });

  it("type sends text that starts with a dash as letters", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, ["type", id, "-n", "--pace", "fast"]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    const clickAt = events.findIndex((event) => event.type === "ButtonPress");
    const keys = events
      .slice(clickAt + 1)
      .filter((event) => event.type === "KeyPress")
      .map((event) => event.keysym);
    expect(keys).toEqual(["minus", "n"]);
  });

  it("key sends a key combo", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    await runCli(env, ["click", id, "700", "400", "--pace", "fast"]);
    // When
    const result = await runCli(env, ["key", id, "ctrl+s", "--pace", "fast"]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    const clickAt = events.findIndex((event) => event.type === "ButtonPress");
    const keys = events
      .slice(clickAt + 1)
      .filter((event) => event.type === "KeyPress")
      .map((event) => event.keysym);
    expect(keys).toEqual(["Control_L", "s"]);
  });

  it("scroll turns the wheel at the point", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, [
      "scroll",
      id,
      "700",
      "400",
      "down",
      "3",
      "--pace",
      "fast",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    expect(events.filter((event) => event.type === "ButtonPress")).toEqual([
      { type: "ButtonPress", root: [700, 400], button: 5 },
      { type: "ButtonPress", root: [700, 400], button: 5 },
      { type: "ButtonPress", root: [700, 400], button: 5 },
    ]);
  });

  it("a scroll with zero steps is refused", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, ["scroll", id, "700", "400", "down", "0"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe("Bad steps 0: scroll needs at least 1\n");
    const events = await readXev(env, id);
    expect(events.filter((event) => event.type === "ButtonPress")).toHaveLength(
      0,
    );
  });

  it("drag presses, moves, and releases", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, [
      "drag",
      id,
      "100",
      "200",
      "500",
      "200",
      "--pace",
      "fast",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const events = await readXev(env, id);
    expect(
      events.filter(
        (event) =>
          event.type === "ButtonPress" || event.type === "ButtonRelease",
      ),
    ).toEqual([
      { type: "ButtonPress", root: [100, 200], button: 1 },
      { type: "ButtonRelease", root: [500, 200], button: 1 },
    ]);
  });

  it("a drag that ends outside the screen does nothing", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    // When
    const result = await runCli(env, ["drag", id, "100", "200", "1500", "200"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Point 1500,200 is outside the screen (1440x900); use x 0 to 1439 and y 0 to 899\n",
    );
    const events = await readXev(env, id);
    expect(
      events.filter(
        (event) =>
          event.type === "ButtonPress" || event.type === "MotionNotify",
      ),
    ).toHaveLength(0);
  });

  it("typing adds a typed line to the Action log when the last letter is in", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const result = await runCli(env, [
      "type",
      id,
      "abcdefghijklmnopqrst",
      "--pace",
      "fast",
      "--letter",
      "100ms",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const cat = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/action-log.jsonl",
    ]);
    const [typeLine, typedLine] = cat.stdout
      .trim()
      .split("\n")
      .slice(-2)
      .map((line) =>
        Schema.decodeUnknownSync(Schema.parseJson(ActionLogLine))(line),
      );
    expect([typeLine?.kind, typedLine?.kind]).toEqual(["type", "typed"]);
    const span = (typedLine?.t ?? 0) - (typeLine?.t ?? 0);
    expect(span).toBeGreaterThanOrEqual(1.8);
    expect(span).toBeLessThanOrEqual(2.2);
  });

  it("each action adds a line to the Action log", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "proofbox-shot-"));
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
    const startSec = await uptime();
    // When
    for (const argv of [
      ["screenshot", id, "--out", join(dir, "a.png")],
      ["click", id, "700", "400"],
      ["type", id, "ab"],
      ["key", id, "Return"],
      ["scroll", id, "700", "400", "down", "2"],
      ["drag", id, "100", "200", "500", "200"],
    ]) {
      const args =
        argv[0] === "screenshot" ? argv : [...argv, "--pace", "fast"];
      const result = await runCli(env, args);
      expect(result.exitCode).toBe(0);
    }
    const endSec = await uptime();
    const cat = await runCli(env, [
      "exec",
      id,
      "--",
      "cat",
      "/run/proofbox/action-log.jsonl",
    ]);
    const lines = cat.stdout
      .trim()
      .split("\n")
      .map((line) =>
        Schema.decodeUnknownSync(Schema.parseJson(ActionLogLine))(line),
      );
    // Then
    expect(lines.map(({ t: _t, ...rest }) => rest)).toEqual([
      { kind: "screenshot", x: 720, y: 450 },
      { kind: "click", x: 700, y: 400 },
      { kind: "type", x: 700, y: 400 },
      { kind: "typed", x: 700, y: 400 },
      { kind: "key", x: 700, y: 400 },
      { kind: "scroll", x: 700, y: 400 },
      { kind: "drag", x: 100, y: 200, toX: 500, toY: 200 },
    ]);
    let previous = startSec;
    for (const line of lines) {
      expect(line.t).toBeGreaterThanOrEqual(startSec - 0.01);
      expect(line.t).toBeLessThanOrEqual(endSec + 0.01);
      expect(line.t).toBeGreaterThanOrEqual(previous);
      previous = line.t;
    }
  });

  it("with FORCE_COLOR=1 each Pixel action prints its ✔ line", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    const out = join(mkdtempSync(join(tmpdir(), "proofbox-shot-")), "shot.png");
    const set = { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" };
    // When
    const stderrs: string[] = [];
    for (const args of [
      ["click", id, "120", "340", "--pace", "fast"],
      ["type", id, "hello", "--pace", "fast"],
      ["key", id, "ctrl+a", "--pace", "fast"],
      ["scroll", id, "400", "300", "down", "3", "--pace", "fast"],
      ["drag", id, "10", "10", "200", "200", "--pace", "fast"],
      ["screenshot", id, "--out", out],
    ]) {
      stderrs.push((await runCli(env, args, { set })).stderr);
    }
    // Then
    expect(stderrs).toEqual([
      "✔ clicked 120,340\n",
      "✔ typed 5 letters\n",
      "✔ pressed ctrl+a\n",
      "✔ scrolled down 3 at 400,300\n",
      "✔ dragged 10,10 to 200,200\n",
      `✔ saved ${out}\n`,
    ]);
  });

  it("click --screenshot writes the screen after the click", async () => {
    // Given
    const env = makeEnv({ docker: true });
    const created = await create(env);
    const id = created.stdout.trim();
    await startXev(env, id);
    const out = join(mkdtempSync(join(tmpdir(), "proofbox-shot-")), "shot.png");
    // When
    const result = await runCli(env, [
      "click",
      id,
      "700",
      "400",
      "--screenshot",
      out,
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.readUInt32BE(16)).toBe(1440);
    expect(bytes.readUInt32BE(20)).toBe(900);
    const events = await readXev(env, id);
    const presses = events.filter((event) => event.type === "ButtonPress");
    expect(presses).toEqual([
      { type: "ButtonPress", root: [700, 400], button: 1 },
    ]);
  });
});
