import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";
import {
  type FakeGithub,
  type FakeGithubAnswer,
  type FakeGithubCall,
  startFakeGithub,
} from "./support/fake-github.ts";

const MAIN = "d5278325679e9452d7a5c95744c9011947fc46c0";
const OLD = "1eafb64200cf09baf0ef068b2465cb950029bdb5";

const dirs: string[] = [];
const servers: FakeGithub[] = [];

afterEach(async () => {
  cleanupEnvs();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A `pnpm` on PATH that logs its argv, prints a line on stdout and one on
// stderr as pnpm does, and exits with $FAKE_PNPM_EXIT (0 by default).
const fakePnpm = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-pnpm-"));
  dirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const log = join(dir, "pnpm.log");
  const path = join(binDir, "pnpm");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf '+ proofbox 0.0.0\\n'\nprintf 'Progress: done\\n' >&2\nexit "\${FAKE_PNPM_EXIT:-0}"\n`,
  );
  chmodSync(path, 0o755);
  return { binDir, log };
};

const fakeGithub = async (
  answer: (call: FakeGithubCall) => FakeGithubAnswer,
) => {
  const server = await startFakeGithub(answer);
  servers.push(server);
  return server;
};

// GitHub answers each known ref with its full commit, and 422 otherwise,
// as the commits API does for a hash it does not know.
const commits =
  (known: Readonly<Record<string, string>>) => (call: FakeGithubCall) => {
    const ref = /^\/repos\/linhvu0711\/proofbox\/commits\/(.+)$/.exec(
      call.path,
    )?.[1];
    const full = ref === undefined ? undefined : known[ref];
    return full === undefined
      ? {
          status: 422,
          body: `{"message":"No commit found for SHA: ${ref}","status":"422"}`,
        }
      : { status: 200, body: full };
  };

const readLog = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8") : undefined;

describe("update", () => {
  it("update installs the newest commit on main with pnpm", async () => {
    // Given: GitHub's main is d527832, and pnpm succeeds
    const github = await fakeGithub(commits({ main: MAIN }));
    const pnpm = fakePnpm();
    // When
    await runCli(makeEnv(), ["update"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({ pnpm: readLog(pnpm.log), calls: github.calls }).toEqual({
      pnpm: `add -g --allow-build=proofbox@https://codeload.github.com/linhvu0711/proofbox/tar.gz/${MAIN} github:linhvu0711/proofbox#${MAIN}\n`,
      calls: [
        {
          path: "/repos/linhvu0711/proofbox/commits/main",
          accept: "application/vnd.github.sha",
        },
      ],
    });
  });

  it("update prints the short commit and passes pnpm's output to stderr", async () => {
    // Given: GitHub's main is d527832, and pnpm succeeds
    const github = await fakeGithub(commits({ main: MAIN }));
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      pnpmOut: result.stderr.includes("+ proofbox 0.0.0\n"),
      pnpmErr: result.stderr.includes("Progress: done\n"),
    }).toEqual({
      exitCode: 0,
      stdout: "d527832\n",
      pnpmOut: true,
      pnpmErr: true,
    });
  });
  it("update --commit installs the commit it names", async () => {
    // Given: GitHub knows 1eafb64, and pnpm succeeds
    const github = await fakeGithub(commits({ "1eafb64": OLD }));
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update", "--commit", "1eafb64"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      pnpm: readLog(pnpm.log),
    }).toEqual({
      exitCode: 0,
      stdout: "1eafb64\n",
      pnpm: `add -g --allow-build=proofbox@https://codeload.github.com/linhvu0711/proofbox/tar.gz/${OLD} github:linhvu0711/proofbox#${OLD}\n`,
    });
  });

  it("update refuses a --commit that is not a hash", async () => {
    // Given: GitHub's main is d527832, and pnpm succeeds
    const github = await fakeGithub(commits({ main: MAIN }));
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update", "--commit", "main"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr,
      calls: github.calls.length,
      pnpm: readLog(pnpm.log),
    }).toEqual({
      exitCode: 125,
      stderr:
        "--commit takes a commit hash of 7 to 40 hex characters, for example d527832.\n",
      calls: 0,
      pnpm: undefined,
    });
  });
  it("update names a commit GitHub does not know", async () => {
    // Given: GitHub knows only main, and pnpm succeeds
    const github = await fakeGithub(commits({ main: MAIN }));
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update", "--commit", "0000000"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr,
      pnpm: readLog(pnpm.log),
    }).toEqual({
      exitCode: 125,
      stderr:
        "Commit 0000000 is not in linhvu0711/proofbox. Pick one from https://github.com/linhvu0711/proofbox/commits/main.\n",
      pnpm: undefined,
    });
  });

  it("update says when GitHub cannot be reached", async () => {
    // Given: a GitHub server that was started and closed, so its port is
    // free; pnpm succeeds
    const github = await startFakeGithub(commits({ main: MAIN }));
    await github.close();
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr,
      pnpm: readLog(pnpm.log),
    }).toEqual({
      exitCode: 125,
      stderr:
        "Could not reach GitHub to look up main. Check the network and try again.\n",
      pnpm: undefined,
    });
  });

  it("update says when GitHub answers with an error", async () => {
    // Given: GitHub refuses every call, as it does past its rate limit;
    // pnpm succeeds
    const github = await fakeGithub(() => ({
      status: 403,
      body: '{"message":"API rate limit exceeded"}',
    }));
    const pnpm = fakePnpm();
    // When
    const result = await runCli(makeEnv(), ["update"], {
      set: {
        PATH: `${pnpm.binDir}:${process.env.PATH}`,
        PROOFBOX_GITHUB_API_URL: github.url,
      },
    });
    // Then
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr,
      pnpm: readLog(pnpm.log),
    }).toEqual({
      exitCode: 125,
      stderr:
        "GitHub answered HTTP 403 to the lookup of main. Try again later.\n",
      pnpm: undefined,
    });
  });
});
