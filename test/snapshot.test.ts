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

const snapshotsDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-snapshots-"));
  trackTempDir(dir);
  return dir;
};

const setupScript = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-setup-"));
  trackTempDir(dir);
  const path = join(dir, "setup.sh");
  writeFileSync(path, content);
  return path;
};

const workFolder = () =>
  makeGitFolder({
    committed: {
      "a.txt": "a\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/web/yarn.lock": "# yarn lockfile v1\n",
    },
  });

const create = (
  env: ReturnType<typeof makeEnv>,
  folder: string,
  script: string,
  set: Readonly<Record<string, string>> = {},
) =>
  runCli(
    env,
    [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      script,
    ],
    { set },
  );

describe("Snapshots", () => {
  afterEach(cleanupEnvs);

  it("a first create with a Setup script saves a Snapshot and prints its Fingerprint", async () => {
    // Given
    const env = makeEnv();
    const dir = snapshotsDir();
    const folder = workFolder();
    const script = setupScript("#!/bin/sh\necho ran >> runs.txt\n");
    // When
    const result = await create(env, folder, script, {
      PROOFBOX_FAKE_SNAPSHOTS: dir,
    });
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 3 files, removed 0 files\nproofbox: running Setup script\nproofbox: saving the Snapshot\nproofbox: Snapshot saved, Fingerprint 22d0cf15eb8e\n",
    );
    expect(readdirSync(dir)).toEqual(["22d0cf15eb8e"]);
  });

  it("a failing Setup script saves no Snapshot", async () => {
    // Given
    const env = makeEnv();
    const dir = snapshotsDir();
    const folder = workFolder();
    const script = setupScript("#!/bin/sh\nexit 3\n");
    // When
    const result = await create(env, folder, script, {
      PROOFBOX_FAKE_SNAPSHOTS: dir,
    });
    // Then
    expect(result.exitCode).toBe(125);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a Provider without Snapshots runs the Setup script on every create", async () => {
    // Given: no PROOFBOX_FAKE_SNAPSHOTS
    const env = makeEnv();
    const folder = workFolder();
    const script = setupScript("#!/bin/sh\necho ran >> runs.txt\n");
    // When
    const first = await create(env, folder, script);
    const second = await create(env, folder, script);
    // Then
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    for (const result of [first, second]) {
      expect(result.stderr).toBe(
        "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 3 files, removed 0 files\nproofbox: running Setup script\n",
      );
    }
  });
});
