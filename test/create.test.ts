import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatClock } from "../src/format-time.ts";
import {
  cleanupEnvs,
  keeperCannotStart,
  makeEnv,
  makeGitFolder,
  runCli,
  trackTempDir,
} from "./support/cli.ts";

const workFixture = () =>
  makeGitFolder({
    committed: {
      "a.txt": "a\n",
      "src/b.txt": "b\n",
      ".gitignore": "dist/\n",
    },
    untracked: { "new.txt": "n\n", "dist/out.js": "x\n" },
  });

const setupScript = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-setup-"));
  const path = join(dir, "setup.sh");
  writeFileSync(path, content);
  return path;
};

const secretsFile = (content: string, mode = 0o600) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
  trackTempDir(dir);
  const path = join(dir, "app.env");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

// The dim lines a create ends with, as the look prints them with NO_COLOR=1,
// each time already replaced by <time>.
const hintLines = (id: string) =>
  `  run a command: proofbox exec ${id} -- <command>\n  delete it: proofbox delete ${id}\n  ends at <time> if idle, at <time> at the latest\n`;

// Elapsed times and clock times change from run to run.
const steady = (stderr: string) =>
  stderr
    .replace(/ {2}\d+(m \d+)?s\n/g, "  <t>\n")
    .replace(/(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}/g, "<time>");

describe("create", () => {
  afterEach(cleanupEnvs);

  it("with FORCE_COLOR=1 a create with no Keeper warns once through Progress", async () => {
    const env = makeEnv();
    const folder = makeGitFolder({ committed: { "a.txt": "a\n" } });
    const script = setupScript("echo hi\n");
    const result = await runCli(
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
      { set: { ...keeperCannotStart(env), FORCE_COLOR: "1" } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(
      result.stderr
        .split("\n")
        .filter((line) => line.includes("Keeper did not start")),
    ).toEqual([
      "\u001b[33m!\u001b[0m Keeper did not start; commands still work, only slower",
    ]);
  });

  it("a create with no Keeper prints only its own Keeper line", async () => {
    // Given: a Work folder and Setup script with a Keeper that cannot start
    const env = makeEnv();
    const set = keeperCannotStart(env);
    const folder = makeGitFolder({ committed: { "a.txt": "a\n" } });
    const script = setupScript("echo hi\n");
    // When
    const result = await runCli(
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
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: Keeper did not start; commands still work, only slower\nproofbox: uploading Work folder\nproofbox: sent 1 file, removed 0 files\nproofbox: running Setup script\n",
    );
  });

  it("create prints a fake Sandbox id", async () => {
    // Given: fresh fake root and runtime dirs
    const env = makeEnv();
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    const name = result.stdout.trim().replace("fake:", "");
    const meta = JSON.parse(
      readFileSync(join(env.root, name, "sandbox.json"), "utf8"),
    );
    expect(meta.os).toBe("linux");
  });

  it("create without --os exits 125 and makes nothing", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(env, ["create", "--provider", "fake"]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("create --work uploads the folder, then runs the Setup script there", async () => {
    // Given: a git folder and a Setup script that reads an uploaded file
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\ncat a.txt > setup-saw.txt\n");
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      script,
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^fake:[a-z0-9]{6}\n$/);
    expect(result.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\nproofbox: running Setup script\n",
    );
    const name = result.stdout.trim().replace("fake:", "");
    expect(
      String(readFileSync(join(env.root, name, "home", "setup-saw.txt"))),
    ).toBe("a\n");
  });

  it("create --work over --max-size makes no Sandbox", async () => {
    // Given: a git folder with one 2 MB file
    const env = makeEnv();
    const folder = makeGitFolder({
      committed: { "big.bin": "x".repeat(2_000_000) },
    });
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--max-size",
      "1MB",
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "Work folder is 2.0 MB, over the 1.0 MB limit, so nothing was sent. Git-ignore the big files, or raise the limit with --max-size.\n",
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("with FORCE_COLOR=1 create --work prints the sent files as a dim line", async () => {
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\ncat a.txt > setup-saw.txt\n");
    const result = await runCli(
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
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    expect(steady(result.stderr)).toBe(
      `✔ creating fake Sandbox  <t>\n✔ starting Keeper  <t>\n✔ uploading Work folder  <t>\n  sent 4 files, removed 0 files\n✔ running Setup script  <t>\n${hintLines(result.stdout.trim())}`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("with FORCE_COLOR=1 create ends with how to use the Sandbox and when it ends", async () => {
    // Given: the fake Provider, which has no Live view, so no live hint
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    // Then
    const id = result.stdout.trim();
    expect(steady(result.stderr)).toBe(
      `✔ creating fake Sandbox  <t>\n✔ starting Keeper  <t>\n  run a command: proofbox exec ${id} -- <command>\n  delete it: proofbox delete ${id}\n  ends at <time> if idle, at <time> at the latest\n`,
    );
  });

  it("with FORCE_COLOR=1 create says it ends at the Deadline the Provider holds", async () => {
    // Given
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake"],
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    // Then: the idle end is the fake's own deadline file, in local time
    const name = result.stdout.trim().replace(/^fake:/, "");
    const seconds = readFileSync(join(env.root, name, "deadline"), "utf8");
    const held = new Date(Number(seconds.trim()) * 1000);
    expect(result.stderr).toContain(
      `  ends at ${formatClock(held, new Date())} if idle, at `,
    );
  });

  it("create --setup without --work makes nothing", async () => {
    // Given: a Setup script but no --work folder
    const env = makeEnv();
    const script = setupScript("#!/bin/sh\necho hi\n");
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--setup",
      script,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      "--setup needs --work <folder>: the Setup script runs in the Work folder. Nothing was created.\n",
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a failing Setup script fails create and prints its last 50 lines", async () => {
    // Given: a git folder and a Setup script that prints 60 lines, then
    // exits 3
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript(
      '#!/bin/sh\nfor i in $(seq 1 60); do echo "line $i"; done\nexit 3\n',
    );
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      script,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stdout).toBe("");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 11}\n`).join(
      "",
    );
    expect(result.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\nproofbox: running Setup script\n" +
        lines +
        "Setup script failed with exit code 3; its last 50 lines are above. Fix the script and create again. This Sandbox was deleted.\n",
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a Setup script printing one endless line still reports a bounded tail", async () => {
    // Given: a git folder and a Setup script that prints 3 MB with no
    // newline, then fails
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript(
      "#!/bin/sh\nhead -c 3000000 /dev/zero | tr '\\0' 'x'\nexit 3\n",
    );
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      script,
    ]);
    // Then: the last-lines output is capped rather than holding all 3 MB
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("Setup script failed with exit code 3");
    expect(result.stderr.length).toBeLessThan(100_000);
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("with FORCE_COLOR=1 a failing Setup script marks its step ✘", async () => {
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript(
      '#!/bin/sh\nfor i in $(seq 1 60); do echo "line $i"; done\nexit 3\n',
    );
    const result = await runCli(
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
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 11}\n`).join(
      "",
    );
    expect(result.stderr.replace(/ {2}\d+(m \d+)?s\n/g, "  <t>\n")).toBe(
      "✔ creating fake Sandbox  <t>\n✔ starting Keeper  <t>\n✔ uploading Work folder  <t>\n  sent 4 files, removed 0 files\n✘ running Setup script\n" +
        lines +
        "✘ Setup script failed with exit code 3; its last 50 lines are above. Fix the script and create again. This Sandbox was deleted.\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("create with a missing Setup script makes nothing", async () => {
    // Given: a git folder and a Setup script path that does not exist
    const env = makeEnv();
    const folder = workFixture();
    const missing = join(
      mkdtempSync(join(tmpdir(), "proofbox-setup-")),
      "none.sh",
    );
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      missing,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Setup script ${missing} not found. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a command run after create --secrets sees each Secret", async () => {
    // Given: a Secrets file with two Secrets
    const env = makeEnv();
    const path = secretsFile(
      "API_TOKEN=tok-5f2a9c\nDB_URL=postgres://app:pw@db:5432/app\n",
    );
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    const id = create.stdout.trim();
    const ran = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'printf "%s|%s" "$API_TOKEN" "$DB_URL"',
    ]);
    // Then
    expect(create.exitCode).toBe(0);
    expect(create.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: sending 2 Secrets\n",
    );
    expect(ran.stdout).toBe("tok-5f2a9c|postgres://app:pw@db:5432/app");
  });

  it("the Setup script runs without the Secrets", async () => {
    // Given: a Work folder, a Setup script that records its env, and a Secrets file
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\nenv > setup-env.txt\n");
    const path = secretsFile(
      "API_TOKEN=tok-5f2a9c\nDB_URL=postgres://app:pw@db:5432/app\n",
    );
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--work",
      folder,
      "--setup",
      script,
      "--secrets",
      path,
    ]);
    const id = create.stdout.trim();
    const name = id.replace("fake:", "");
    const setupEnv = String(
      readFileSync(join(env.root, name, "home", "setup-env.txt")),
    );
    const seen = await runCli(env, ["exec", id, "--", "printenv", "API_TOKEN"]);
    // Then
    expect(create.exitCode).toBe(0);
    expect(create.stderr).toBe(
      "proofbox: creating fake Sandbox\nproofbox: starting Keeper\nproofbox: uploading Work folder\nproofbox: sent 4 files, removed 0 files\nproofbox: running Setup script\nproofbox: sending 2 Secrets\n",
    );
    expect(setupEnv).not.toContain("API_TOKEN");
    expect(setupEnv).not.toContain("DB_URL");
    expect(seen.stdout).toBe("tok-5f2a9c\n");
  });

  it("no Secret value reaches proofbox output or its files", async () => {
    // Given: a Secrets file with one Secret
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\n");
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    const id = create.stdout.trim();
    const name = id.replace("fake:", "");
    const ran = await runCli(env, ["exec", id, "--", "true"]);
    const leaked: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          statSync(full).isFile() &&
          readFileSync(full).includes("tok-5f2a9c")
        ) {
          leaked.push(full);
        }
      }
    };
    walk(env.root);
    walk(env.runtime);
    // Then
    expect(
      create.stdout + create.stderr + ran.stdout + ran.stderr,
    ).not.toContain("tok-5f2a9c");
    expect(leaked).toEqual([join(env.root, name, "secrets", "env")]);
  });

  it("create --secrets reads dotenv lines", async () => {
    // Given: a Secrets file using dotenv syntax
    const env = makeEnv();
    const path = secretsFile(
      '# app secrets\nexport API_TOKEN=tok-5f2a9c\n\nDB_URL = "postgres://app:pw@db:5432/app"\nGREETING=\'hi there\'\r\nHASH=abc#def\nQUOTE=it\'s\nAPI_TOKEN=tok-later\nNOTE=abc   # staging\nQUOTED="abc # x"\nQ2="abc" # note\n',
    );
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    const id = create.stdout.trim();
    const ran = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'printf "%s|" "$API_TOKEN" "$DB_URL" "$GREETING" "$HASH" "$QUOTE" "$NOTE" "$QUOTED" "$Q2"',
    ]);
    // Then
    expect(create.exitCode).toBe(0);
    expect(create.stderr.endsWith("proofbox: sending 8 Secrets\n")).toBe(true);
    expect(ran.stdout).toBe(
      "tok-later|postgres://app:pw@db:5432/app|hi there|abc#def|it's|abc|abc # x|abc|",
    );
  });

  it("a Secrets line with no = fails create with its line number", async () => {
    // Given: a Secrets file whose second line is not NAME=VALUE
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\nnot a line\n");
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${path} line 2 is not NAME=VALUE; fix that line. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a Secrets line with a bad name fails create without its value", async () => {
    // Given: a Secrets file whose third line has a name that is not a valid name
    const env = makeEnv();
    const path = secretsFile(
      "# first\nAPI_TOKEN=tok-5f2a9c\n1BAD=tok-9d3e71\n",
    );
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${path} line 3 is not NAME=VALUE; fix that line. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a Secrets line with an unclosed quote fails create with its line number", async () => {
    // Given: a Secrets file whose third line opens a quote it never closes
    const env = makeEnv();
    const path = secretsFile('# first\nAPI_TOKEN=tok-5f2a9c\nTOKEN="abc\n');
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${path} line 3 is not NAME=VALUE; fix that line. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("create with a missing Secrets file makes nothing", async () => {
    // Given: a Secrets file path that does not exist
    const env = makeEnv();
    const missing = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
        trackTempDir(dir);
        return dir;
      })(),
      "none.env",
    );
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      missing,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${missing} not found. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("create with an unreadable Secrets file makes nothing", async () => {
    // Given: a Secrets file mode 000
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\n", 0o000);
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${path} is not readable. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("create with a folder as Secrets file makes nothing", async () => {
    // Given: a folder passed as the Secrets file
    const env = makeEnv();
    const folder = mkdtempSync(join(tmpdir(), "proofbox-env-"));
    trackTempDir(folder);
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      folder,
    ]);
    // Then
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toBe(
      `Secrets file ${folder} is a folder. Nothing was created.\n`,
    );
    expect(existsSync(env.root) ? readdirSync(env.root) : []).toEqual([]);
  });

  it("a Secrets file other users can read gets a warning", async () => {
    // Given: a Secrets file mode 644
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\n", 0o644);
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--secrets",
      path,
    ]);
    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      `proofbox: Secrets file ${path} is mode 644, so other users can read it; run chmod 600 ${path}\n` +
        "proofbox: creating fake Sandbox\n" +
        "proofbox: starting Keeper\n" +
        "proofbox: sending 1 Secret\n",
    );
  });

  it("with FORCE_COLOR=1 a Secrets file other users can read gets a ! warning", async () => {
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\n", 0o644);
    const result = await runCli(
      env,
      ["create", "--os", "linux", "--provider", "fake", "--secrets", path],
      { set: { FORCE_COLOR: "1", NO_COLOR: "1", NODE_NO_WARNINGS: "1" } },
    );
    expect(steady(result.stderr)).toBe(
      `! Secrets file ${path} is mode 644, so other users can read it; run chmod 600 ${path}\n✔ creating fake Sandbox  <t>\n✔ starting Keeper  <t>\n✔ sending 1 Secret  <t>\n${hintLines(result.stdout.trim())}`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("create --env-file fails as an unknown argument", async () => {
    // Given: a Secrets file, passed with the old flag
    const env = makeEnv();
    const path = secretsFile("API_TOKEN=tok-5f2a9c\n");
    // When
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--env-file",
      path,
    ]);
    // Then
    expect({
      exitCode: result.exitCode,
      unknown: result.stderr.includes(
        "Received unknown argument: '--env-file'",
      ),
      made: existsSync(env.root) ? readdirSync(env.root) : [],
    }).toEqual({ exitCode: 125, unknown: true, made: [] });
  });
});
