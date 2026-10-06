import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CliEnv,
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

const create = (
  env: CliEnv,
  folder: string,
  script: string,
  set: Record<string, string> = {},
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

describe("Setup env", () => {
  afterEach(cleanupEnvs);

  it("a Setup script gets $PROOFBOX_ENV as a file it can write", async () => {
    // Given: a Setup script that records whether $PROOFBOX_ENV is a
    // writable file
    const env = makeEnv();
    const script = setupScript(
      '#!/bin/sh\nif [ -f "$PROOFBOX_ENV" ] && [ -w "$PROOFBOX_ENV" ]; then echo writable > saw.txt; fi\n',
    );
    // When
    const created = await create(env, workFixture(), script);
    const name = created.stdout.trim().replace("fake:", "");
    // Then
    expect({
      exitCode: created.exitCode,
      saw: readFileSync(join(env.root, name, "home", "saw.txt"), "utf8"),
    }).toEqual({ exitCode: 0, saw: "writable\n" });
  });

  it("exec runs a tool from the PATH the Setup script wrote", async () => {
    // Given: a Setup script that installs `hello` in a folder of its own
    // and puts that folder on the PATH
    const env = makeEnv();
    const script = setupScript(
      '#!/bin/sh\nset -eu\nmkdir -p tools\nprintf \'#!/bin/sh\\necho hello 1.0\\n\' > tools/hello\nchmod +x tools/hello\necho "PATH=$PWD/tools:$PATH" >> "$PROOFBOX_ENV"\n',
    );
    const created = await create(env, workFixture(), script);
    // When
    const ran = await runCli(env, [
      "exec",
      created.stdout.trim(),
      "--",
      "hello",
    ]);
    // Then
    expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({
      exitCode: 0,
      stdout: "hello 1.0\n",
    });
  });

  it("a Setup env value keeps a quoted # like the Secrets file", async () => {
    // Given: a Setup script that writes a quoted value with a #
    const env = makeEnv();
    const script = setupScript(
      '#!/bin/sh\necho \'GREETING="a b # c"\' >> "$PROOFBOX_ENV"\n',
    );
    const created = await create(env, workFixture(), script);
    // When
    const ran = await runCli(env, [
      "exec",
      created.stdout.trim(),
      "--",
      "sh",
      "-c",
      'echo "$GREETING"',
    ]);
    // Then
    expect(ran.stdout).toBe("a b # c\n");
  });

  it("a create from the Snapshot gets the Setup env without running the Setup script", async () => {
    // Given: a first create that saved a Snapshot
    const env = makeEnv();
    const set = { PROOFBOX_FAKE_SNAPSHOTS: snapshotsDir() };
    const folder = workFixture();
    const script = setupScript(
      '#!/bin/sh\necho ran >> runs.txt\necho GREETING=hi >> "$PROOFBOX_ENV"\n',
    );
    const first = await create(env, folder, script, set);
    expect(first.exitCode).toBe(0);
    // When
    const second = await create(env, folder, script, set);
    const id = second.stdout.trim();
    const runs = await runCli(env, ["exec", id, "--", "cat", "runs.txt"], {
      set,
    });
    const greeting = await runCli(
      env,
      ["exec", id, "--", "sh", "-c", 'echo "$GREETING"'],
      { set },
    );
    // Then
    expect({
      reused: second.stderr.includes("Snapshot reused, Fingerprint"),
      setupRan: second.stderr.includes("running Setup script"),
      runs: runs.stdout,
      greeting: greeting.stdout,
    }).toEqual({
      reused: true,
      setupRan: false,
      runs: "ran\n",
      greeting: "hi\n",
    });
  });

  it("a Setup script that writes nothing changes no exec", async () => {
    // Given: a Setup script that writes no Setup env
    const env = makeEnv();
    const script = setupScript("#!/bin/sh\ntrue\n");
    const created = await create(env, workFixture(), script);
    // When
    const ran = await runCli(env, [
      "exec",
      created.stdout.trim(),
      "--",
      "sh",
      "-c",
      "printenv GREETING || echo unset",
    ]);
    // Then
    expect({ exitCode: created.exitCode, stdout: ran.stdout }).toEqual({
      exitCode: 0,
      stdout: "unset\n",
    });
  });

  it("a Setup script that deletes $PROOFBOX_ENV changes no exec", async () => {
    // Given: a Setup script that removes the file it was given
    const env = makeEnv();
    const script = setupScript('#!/bin/sh\nrm -f "$PROOFBOX_ENV"\n');
    const created = await create(env, workFixture(), script);
    // When
    const ran = await runCli(env, [
      "exec",
      created.stdout.trim(),
      "--",
      "sh",
      "-c",
      "printenv GREETING || echo unset",
    ]);
    // Then
    expect({ exitCode: created.exitCode, stdout: ran.stdout }).toEqual({
      exitCode: 0,
      stdout: "unset\n",
    });
  });

  it("a Sandbox with no Setup env file runs exec as before", async () => {
    // Given: a Sandbox whose Setup env file is gone, as in a Snapshot made
    // before the Setup env
    const env = makeEnv();
    const script = setupScript(
      '#!/bin/sh\necho GREETING=hi >> "$PROOFBOX_ENV"\n',
    );
    const created = await create(env, workFixture(), script);
    const id = created.stdout.trim();
    rmSync(join(env.root, id.replace("fake:", ""), "state", "setup-env"));
    // When
    const ran = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "printenv GREETING || echo unset",
    ]);
    // Then
    expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({
      exitCode: 0,
      stdout: "unset\n",
    });
  });

  it("a bad Setup env line fails create with its line number and leaves no Sandbox", async () => {
    // Given: a Setup script whose second Setup env line is not NAME=VALUE
    const env = makeEnv();
    const script = setupScript(
      '#!/bin/sh\necho GREETING=hi >> "$PROOFBOX_ENV"\necho \'not a setting\' >> "$PROOFBOX_ENV"\n',
    );
    // When
    const created = await create(env, workFixture(), script);
    const listed = await runCli(env, ["list"]);
    // Then
    expect({
      exitCode: created.exitCode,
      stdout: created.stdout,
      lastLine: created.stderr.split("\n").at(-2),
      listed: listed.stdout,
      made: existsSync(env.root) ? readdirSync(env.root) : [],
    }).toEqual({
      exitCode: 125,
      stdout: "",
      lastLine:
        "$PROOFBOX_ENV line 2 is not NAME=VALUE; fix the Setup script and create again. This Sandbox was deleted.",
      listed: "",
      made: [],
    });
  });

  it("a bad Setup env line saves no Snapshot, so the next create runs the Setup script again", async () => {
    // Given: a Setup script with a bad Setup env line, and Snapshots on
    const env = makeEnv();
    const dir = snapshotsDir();
    const set = { PROOFBOX_FAKE_SNAPSHOTS: dir };
    const folder = workFixture();
    const script = setupScript(
      '#!/bin/sh\necho GREETING=hi >> "$PROOFBOX_ENV"\necho \'not a setting\' >> "$PROOFBOX_ENV"\n',
    );
    // When
    await create(env, folder, script, set);
    const saved = readdirSync(dir);
    const second = await create(env, folder, script, set);
    // Then
    expect({
      saved,
      setupRan: second.stderr.includes("running Setup script"),
      reused: second.stderr.includes("Snapshot reused"),
    }).toEqual({ saved: [], setupRan: true, reused: false });
  });
});
