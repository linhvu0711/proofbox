import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const writeFakeSandbox = (root: string, name: string, idleSeconds = 900) => {
  mkdirSync(join(root, name, "home"), { recursive: true });
  writeFileSync(
    join(root, name, "sandbox.json"),
    `${JSON.stringify({
      os: "linux",
      idleSeconds,
      createdAt: "2999-01-01T00:00:00.000Z",
      deadline: "2999-01-01T00:15:00.000Z",
      maxLifeAt: "2999-01-01T03:00:00.000Z",
    })}\n`,
  );
};

// A Sandbox folder a create started and never finished: no sandbox.json.
const writeUnfinished = (root: string, name: string, ageSeconds = 0) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(dir, at, at);
};

const unfinishedLine = (id: string, started: string) =>
  `Unfinished Sandbox ${id} (linux, started ${started}): a create may still be making it, or one stopped part way. It counts against your fake quota until you delete it. Run: proofbox delete ${id}\n`;

describe("list", () => {
  afterEach(cleanupEnvs);

  it("list reads Sandboxes from the Provider, not local state", async () => {
    // Given: a Sandbox folder written by hand, no CLI run
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    // When
    const result = await runCli(env, ["list"]);
    // Then
    expect(result.stdout).toBe(
      "fake:qqqqqq  linux  deadline 2999-01-01T00:15:00Z  max life 2999-01-01T03:00:00Z\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("list refuses a Sandbox whose idle time is not a whole number of seconds", async () => {
    // Given: hand-written Sandboxes with a negative and a fractional idle time
    for (const idle of [-3, 1.5]) {
      const env = makeEnv();
      writeFakeSandbox(env.root, "qqqqqq", idle);
      // When
      const result = await runCli(env, ["list"]);
      // Then
      expect(result.stderr).toContain('["idleSeconds"]');
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(125);
    }
  });

  it("list --json gives id, os, deadline, and maxLife", async () => {
    // Given: the same hand-written qqqqqq Sandbox
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    // When
    const result = await runCli(env, ["list", "--json"]);
    // Then
    expect(result.stdout).toBe(
      '[{"id":"fake:qqqqqq","os":"linux","deadline":"2999-01-01T00:15:00Z","maxLife":"2999-01-01T03:00:00Z"}]\n',
    );
    expect(result.exitCode).toBe(0);
  });

  it("list names a region it could not reach and still lists the rest", async () => {
    // Given: a Sandbox plus a fake region that does not answer
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    // When
    const result = await runCli(env, ["list"], {
      set: { PROOFBOX_FAKE_UNREACHED: "eu" },
    });
    // Then
    expect(result.stderr).toBe(
      "Could not list Sandboxes in fake region eu: fake region eu did not answer\n",
    );
    expect(result.stdout).toBe(
      "fake:qqqqqq  linux  deadline 2999-01-01T00:15:00Z  max life 2999-01-01T03:00:00Z\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("list names a Provider it could not reach at all and still exits 0", async () => {
    // Given: the fake Provider's list itself does not answer
    const env = makeEnv();
    // When
    const result = await runCli(env, ["list"], {
      set: { PROOFBOX_FAKE_LIST_DOWN: "fake did not answer" },
    });
    // Then: the Provider is named like an unreached region, exit 0
    expect(result.stderr).toBe(
      "Could not list Sandboxes in fake: fake did not answer\nNo live Sandboxes\n",
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("list with no Sandbox says so on stderr", async () => {
    // Given
    const env = makeEnv();
    // When
    const plain = await runCli(env, ["list"]);
    const json = await runCli(env, ["list", "--json"]);
    // Then
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toBe("No live Sandboxes\n");
    expect(plain.exitCode).toBe(0);
    expect(json.stdout).toBe("[]\n");
  });

  it("list names an Unfinished Sandbox on stderr and keeps it out of stdout", async () => {
    // Given: one full Sandbox and one a create left 12 min 30 s ago
    const env = makeEnv();
    writeFakeSandbox(env.root, "qqqqqq");
    writeUnfinished(env.root, "uuuuuu", 750);
    // When
    const plain = await runCli(env, ["list"]);
    const json = await runCli(env, ["list", "--json"]);
    // Then
    expect({
      stdout: plain.stdout,
      stderr: plain.stderr,
      json: json.stdout,
      exitCodes: [plain.exitCode, json.exitCode],
    }).toEqual({
      stdout:
        "fake:qqqqqq  linux  deadline 2999-01-01T00:15:00Z  max life 2999-01-01T03:00:00Z\n",
      stderr: unfinishedLine("fake:uuuuuu", "12 min ago"),
      json: '[{"id":"fake:qqqqqq","os":"linux","deadline":"2999-01-01T00:15:00Z","maxLife":"2999-01-01T03:00:00Z"}]\n',
      exitCodes: [0, 0],
    });
  });

  it("list with only an Unfinished Sandbox still says No live Sandboxes", async () => {
    // Given: only a Sandbox a create just started
    const env = makeEnv();
    writeUnfinished(env.root, "uuuuuu");
    // When
    const plain = await runCli(env, ["list"]);
    const json = await runCli(env, ["list", "--json"]);
    // Then
    expect({
      stdout: plain.stdout,
      stderr: plain.stderr,
      json: json.stdout,
      exitCodes: [plain.exitCode, json.exitCode],
    }).toEqual({
      stdout: "",
      stderr: `${unfinishedLine("fake:uuuuuu", "under 1 min ago")}No live Sandboxes\n`,
      json: "[]\n",
      exitCodes: [0, 0],
    });
  });

  it("list names an Unfinished Sandbox after a region it could not reach", async () => {
    // Given: a Sandbox a create just started, and a region that does not answer
    const env = makeEnv();
    writeUnfinished(env.root, "uuuuuu");
    // When
    const result = await runCli(env, ["list"], {
      set: { PROOFBOX_FAKE_UNREACHED: "eu" },
    });
    // Then
    expect({ stderr: result.stderr, exitCode: result.exitCode }).toEqual({
      stderr: `Could not list Sandboxes in fake region eu: fake region eu did not answer\n${unfinishedLine("fake:uuuuuu", "under 1 min ago")}No live Sandboxes\n`,
      exitCode: 0,
    });
  });
});
