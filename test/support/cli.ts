import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface CliEnv {
  readonly root: string;
  readonly runtime: string;
  readonly env: {
    readonly PROOFBOX_FAKE_ROOT: string;
    readonly PROOFBOX_RUNTIME_DIR: string;
    readonly DOCKER_HOST?: string;
    readonly PROOFBOX_NSC?: string;
  };
}

const made: string[] = [];

export const makeEnv = (
  options: { readonly docker?: boolean; readonly namespace?: boolean } = {},
): CliEnv => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  // ssh control sockets live in the runtime dir, and macOS caps a socket
  // path at 103 characters; its per-user tmpdir is too long for that.
  const runtime = mkdtempSync(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "proofbox-runtime-",
    ),
  );
  made.push(root, runtime);
  return {
    root,
    runtime,
    env: {
      PROOFBOX_FAKE_ROOT: root,
      PROOFBOX_RUNTIME_DIR: runtime,
      // Plain tests must not touch the host Docker daemon.
      ...(options.docker === true
        ? {}
        : { DOCKER_HOST: "unix:///nonexistent/proofbox-test.sock" }),
      // Plain tests must not touch the real nsc binary either.
      ...(options.namespace === true
        ? {}
        : { PROOFBOX_NSC: "/nonexistent/proofbox-test-nsc" }),
    },
  };
};

export const cleanupEnvs = () => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const trackTempDir = (dir: string): void => {
  made.push(dir);
};

export const makeGitFolder = (options: {
  readonly committed: Record<string, string>;
  readonly untracked?: Record<string, string>;
}): string => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-work-"));
  made.push(dir);
  const write = (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
  };
  write(options.committed);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=proofbox",
      "-c",
      "user.email=test@proofbox.invalid",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: dir },
  );
  write(options.untracked ?? {});
  return dir;
};

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const runCli = (
  env: CliEnv,
  args: ReadonlyArray<string>,
  options: {
    readonly set?: Readonly<Record<string, string>>;
    readonly unset?: ReadonlyArray<string>;
    readonly input?: string;
  } = {},
): Promise<CliResult> =>
  new Promise((resolve) => {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...env.env,
      ...options.set,
    };
    for (const key of options.unset ?? []) {
      delete childEnv[key];
    }
    const child = execFile(
      process.execPath,
      // `--` ends Node's own flag scan; without it Node treats a
      // `--env-file` meant for the CLI as its own (nodejs/node#54232).
      ["--disable-warning=ExperimentalWarning", "--", "src/main.ts", ...args],
      // The Namespace Provider's create builds the Base image on a fresh
      // host, which can run for minutes, and on failure may still need a
      // few seconds to delete the host before the process exits.
      { cwd: repoRoot, env: childEnv, timeout: 480_000 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
        });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
