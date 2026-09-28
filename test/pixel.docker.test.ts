import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import { readXev, startXev } from "./support/xev.ts";

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
