import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface CliEnv {
  readonly root: string;
  readonly runtime: string;
  readonly env: {
    readonly PROOFBOX_FAKE_ROOT: string;
    readonly PROOFBOX_RUNTIME_DIR: string;
  };
}

const made: string[] = [];

export const makeEnv = (): CliEnv => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
  made.push(root, runtime);
  return {
    root,
    runtime,
    env: { PROOFBOX_FAKE_ROOT: root, PROOFBOX_RUNTIME_DIR: runtime },
  };
};

export const cleanupEnvs = () => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const runCli = (
  env: CliEnv,
  args: ReadonlyArray<string>,
): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/main.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env.env },
      },
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
  });
