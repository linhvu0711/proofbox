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
    readonly PROOFBOX_FAKE_TOKEN: string;
    readonly DOCKER_HOST?: string;
    readonly PROOFBOX_NAMESPACE_COMPUTE_URL?: string;
    readonly PROOFBOX_NAMESPACE_IAM_URL?: string;
    readonly PROOFBOX_NAMESPACE_TOKEN_URL?: string;
    readonly PROOFBOX_OPEN?: string;
    readonly HOME?: string;
  };
}

const made: string[] = [];

export const makeEnv = (
  options: { readonly docker?: boolean; readonly namespace?: boolean } = {},
): CliEnv => {
  const root = mkdtempSync(join(tmpdir(), "proofbox-fake-"));
  const home =
    options.namespace === true || options.docker === true
      ? undefined
      : mkdtempSync(join(tmpdir(), "proofbox-home-"));
  // ssh control sockets live in the runtime dir, and macOS caps a socket
  // path at 103 characters; its per-user tmpdir is too long for that.
  const runtime = mkdtempSync(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "proofbox-runtime-",
    ),
  );
  made.push(root, runtime, ...(home === undefined ? [] : [home]));
  return {
    root,
    runtime,
    env: {
      PROOFBOX_FAKE_ROOT: root,
      PROOFBOX_RUNTIME_DIR: runtime,
      // The fake Provider needs a login; plain tests log in with the
      // env token unless they unset it.
      PROOFBOX_FAKE_TOKEN: "t0k",
      // Plain tests must not touch the host Docker daemon.
      ...(options.docker === true
        ? {}
        : { DOCKER_HOST: "unix:///nonexistent/proofbox-test.sock" }),
      // Plain tests must not touch the real Compute API: port 9
      // never answers.
      ...(options.namespace === true
        ? {}
        : {
            PROOFBOX_NAMESPACE_COMPUTE_URL: "http://127.0.0.1:9/{region}",
            PROOFBOX_NAMESPACE_IAM_URL: "http://127.0.0.1:9",
            PROOFBOX_NAMESPACE_TOKEN_URL: "http://127.0.0.1:9",
            PROOFBOX_OPEN: "/nonexistent/proofbox-test-open",
          }),
      // Plain tests must not read the developer's own logins file.
      ...(home === undefined ? {} : { HOME: home }),
    },
  };
};

export const cleanupEnvs = () => {
  for (const dir of made.splice(0)) {
    // A Keeper still logging a command whose Caller left can land a file
    // in the runtime dir; the retries let that write finish first.
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
};

// A socket path this long fails at once on macOS and Linux, so the Keeper cannot start.
export const keeperCannotStart = (
  env: CliEnv,
): Readonly<Record<string, string>> => {
  const runtime = join(env.runtime, "k".repeat(110));
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  return { PROOFBOX_RUNTIME_DIR: runtime };
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
    readonly maxBuffer?: number;
    readonly timeout?: number;
    readonly set?: Readonly<Record<string, string>>;
    readonly unset?: ReadonlyArray<string>;
    readonly input?: string;
    // Sees stderr as it comes, while the command still runs; `interrupt`
    // sends it SIGINT, as Ctrl-C does.
    readonly onStderr?: (chunk: string, interrupt: () => void) => void;
    // Gets `interrupt` as soon as the command starts, for a test that
    // sends Ctrl-C on a signal of its own rather than on output.
    readonly onSpawn?: (interrupt: () => void) => void;
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
      ["--", "src/main.ts", ...args],
      // The Namespace Provider's create builds the Base image on a fresh
      // host, which can run for minutes, and on failure may still need a
      // few seconds to delete the host before the process exits.
      {
        cwd: repoRoot,
        env: childEnv,
        timeout: options.timeout ?? 480_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
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
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
    options.onSpawn?.(() => child.kill("SIGINT"));
    const onStderr = options.onStderr;
    if (onStderr !== undefined) {
      child.stderr?.on("data", (chunk: Buffer | string) =>
        onStderr(String(chunk), () => child.kill("SIGINT")),
      );
    }
  });
