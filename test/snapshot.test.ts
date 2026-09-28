import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupEnvs,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./support/cli.ts";

const workFixture = () =>
  makeGitFolder({
    committed: {
      "a.txt": "a\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/web/yarn.lock": "# yarn lockfile v1\n",
    },
  });

const setupScript = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-setup-"));
  trackTempDir(dir);
  const path = join(dir, "setup.sh");
  writeFileSync(path, content);
  return path;
};

const snapshotsDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
  trackTempDir(dir);
  return dir;
};

const createArgs = (folder: string, script: string) => [
  "create",
  "--os",
  "linux",
  "--provider",
  "fake",
  "--work",
  folder,
  "--setup",
  script,
];

describe("Snapshots", () => {
  afterEach(cleanupEnvs);

  it("a first create with a Setup script saves a Snapshot and prints its Fingerprint", async () => {
    // Given
    const env = makeEnv();
    const dir = snapshotsDir();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\necho ran >> runs.txt\n");
    // When
    const result = await runCli(env, createArgs(folder, script), {
      set: { PROOFBOX_FAKE_SNAPSHOTS: dir },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stdoutOk: /^fake:[a-z0-9]{6}\n$/.test(result.stdout),
      stderr: result.stderr,
      snapshots: readdirSync(dir),
    }).toEqual({
      exitCode: 0,
      stdoutOk: true,
      stderr:
        "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 3 files, removed 0 files\nproofbox: running Setup script\nproofbox: saving the Snapshot\nproofbox: Snapshot saved, Fingerprint 22d0cf15eb8e\n",
      snapshots: ["22d0cf15eb8e"],
    });
  });

  it("a failing Setup script saves no Snapshot", async () => {
    // Given
    const env = makeEnv();
    const dir = snapshotsDir();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\nexit 3\n");
    // When
    const result = await runCli(env, createArgs(folder, script), {
      set: { PROOFBOX_FAKE_SNAPSHOTS: dir },
    });
    // Then
    expect({ exitCode: result.exitCode, snapshots: readdirSync(dir) }).toEqual({
      exitCode: 125,
      snapshots: [],
    });
  });

  it("a Provider without Snapshots runs the Setup script on every create", async () => {
    // Given
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\necho ran >> runs.txt\n");
    // When
    const first = await runCli(env, createArgs(folder, script));
    const second = await runCli(env, createArgs(folder, script));
    // Then
    const expected = {
      exitCode: 0,
      stderr:
        "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 3 files, removed 0 files\nproofbox: running Setup script\n",
    };
    expect([
      { exitCode: first.exitCode, stderr: first.stderr },
      { exitCode: second.exitCode, stderr: second.stderr },
    ]).toEqual([expected, expected]);
  });
});
