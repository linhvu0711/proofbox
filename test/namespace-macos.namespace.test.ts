import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "pgrep",
      "-f",
      "/usr/bin/log stream",
    ]);
    // Then
    expect(found.exitCode).toBe(0);
  });

  it("live and record on a Mac are refused until #15", async () => {
    // Given: the Mac from beforeAll
    // When
    const live = await runCli(env, ["live", id]);
    const record = await runCli(env, ["record", "start", id]);
    // Then
    expect(live.stderr).toBe(
      "Provider namespace lacks the Capability live-view on macos; no Live view was opened\n",
    );
    expect(live.exitCode).toBe(125);
    expect(record.stderr).toBe(
      "Provider namespace lacks the Capability recording on macos; no Recording was started\n",
    );
    expect(record.exitCode).toBe(125);
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
