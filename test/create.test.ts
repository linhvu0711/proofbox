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
import { cleanupEnvs, makeEnv, makeGitFolder, runCli } from "./support/cli.ts";

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

const envFile = (content: string, mode = 0o600) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-env-"));
  const path = join(dir, "app.env");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

describe("create", () => {
  afterEach(cleanupEnvs);

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

  it("a command run after create --env-file sees each Secret", async () => {
    // Given: an env file with two Secrets
    const env = makeEnv();
    const path = envFile(
      "API_TOKEN=tok-5f2a9c\nDB_URL=postgres://app:pw@db:5432/app\n",
    );
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--env-file",
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
    // Given: a Work folder, a Setup script that records its env, and an env file
    const env = makeEnv();
    const folder = workFixture();
    const script = setupScript("#!/bin/sh\nenv > setup-env.txt\n");
    const path = envFile(
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
      "--env-file",
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
    // Given: an env file with one Secret
    const env = makeEnv();
    const path = envFile("API_TOKEN=tok-5f2a9c\n");
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--env-file",
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

  it("create --env-file reads dotenv lines", async () => {
    // Given: an env file using dotenv syntax
    const env = makeEnv();
    const path = envFile(
      "# app secrets\nexport API_TOKEN=tok-5f2a9c\n\nDB_URL = \"postgres://app:pw@db:5432/app\"\nGREETING='hi there'\r\nHASH=abc#def\nQUOTE=it's\nAPI_TOKEN=tok-later\n",
    );
    // When
    const create = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "fake",
      "--env-file",
      path,
    ]);
    const id = create.stdout.trim();
    const ran = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      'printf "%s|" "$API_TOKEN" "$DB_URL" "$GREETING" "$HASH" "$QUOTE"',
    ]);
    // Then
    expect(create.exitCode).toBe(0);
    expect(create.stderr.endsWith("proofbox: sending 5 Secrets\n")).toBe(true);
    expect(ran.stdout).toBe(
      "tok-later|postgres://app:pw@db:5432/app|hi there|abc#def|it's|",
    );
  });
});
