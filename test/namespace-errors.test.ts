import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";
import { makeFakeNsc } from "./support/fake-nsc.ts";

const CREATE = ["create", "--os", "linux", "--provider", "namespace"];

const logLines = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");

describe("Namespace errors", () => {
  afterEach(cleanupEnvs);

  it("create with no nsc says to install it and run nsc login", async () => {
    // Given: makeEnv points PROOFBOX_NSC at no file
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE);
    // Then
    expect(result.stderr).toBe(
      "nsc is not installed; install the Namespace CLI, then run: nsc login\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      readdirSync(env.runtime).filter((name) => name.startsWith("ns-")),
    ).toEqual([]);
  });

  it("create when nsc is not logged in says to run nsc login", async () => {
    // Given: every nsc call fails with the not-logged-in output
    const fake = makeFakeNsc(
      "printf 'Failed:\\nnot logged in\\n\\nplease run `nsc login`\\n' >&2\nexit 1",
    );
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: { PROOFBOX_NSC: fake.path },
    });
    // Then
    expect(result.stderr).toBe("Namespace: not logged in; run: nsc login\n");
    expect(result.exitCode).toBe(125);
  });

  it("a Namespace limit exits with the limit and leaves nothing", async () => {
    // Given: create hangs, and on interrupt reports the capacity limit
    const fake = makeFakeNsc(`case "$1" in
auth) exit 0 ;;
create)
  trap 'printf "Failed: ran out of capacity: 1st instance limit (want 64 vCPU 128 GB RAM; used all of 32 vCPU 128 GB\\nRAM) https://namespace.so/e/resource-limits (rid=x).\\n" >&2; exit 1' INT
  sleep 30 </dev/null >/dev/null 2>&1 & wait ;;
esac`);
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: {
        PROOFBOX_NSC: fake.path,
        PROOFBOX_NS_CREATE_TIMEOUT: "1s",
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Namespace refused the Sandbox: ran out of capacity: 1st instance limit (want 64 vCPU 128 GB RAM; used all of 32 vCPU 128 GB RAM); nothing was created. Delete a Sandbox or use a smaller --size\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      logLines(fake.log).filter((line) => line.startsWith("destroy")),
    ).toEqual([]);
    expect(
      readdirSync(env.runtime).filter((name) => name.startsWith("ns-")),
    ).toEqual([]);
  });

  it("a Namespace macOS limit exits with the limit and leaves nothing", async () => {
    // Given: create hangs, and on interrupt reports the macOS capacity limit
    const fake = makeFakeNsc(`case "$1" in
auth) exit 0 ;;
create)
  trap 'printf "Failed: ran out of capacity: 1st instance limit (want 6 vCPU 14 GB RAM; used all of 6 vCPU 14 GB\\nRAM) https://namespace.so/e/resource-limits (rid=x).\\n" >&2; exit 1' INT
  sleep 30 </dev/null >/dev/null 2>&1 & wait ;;
esac`);
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "macos", "--provider", "namespace"],
      {
        set: {
          PROOFBOX_NSC: fake.path,
          PROOFBOX_NS_CREATE_TIMEOUT: "1s",
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Namespace refused the Sandbox: ran out of capacity: 1st instance limit (want 6 vCPU 14 GB RAM; used all of 6 vCPU 14 GB RAM); nothing was created. Delete a Sandbox or use a smaller --size\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      logLines(fake.log).filter((line) => line.startsWith("destroy")),
    ).toEqual([]);
    expect(
      readdirSync(env.runtime).filter((name) => name.startsWith("ns-")),
    ).toEqual([]);
  });

  it("a create that times out deletes the half-made host", async () => {
    // Given: create hangs, then reports the host was still made
    const fake = makeFakeNsc(`case "$1" in
auth) exit 0 ;;
create)
  trap 'printf "Failed: context canceled\\n" >&2; exit 1' INT
  sleep 30 </dev/null >/dev/null 2>&1 & wait ;;
list) printf '[{"cluster_id":"abc123def4567","created_at":"2026-09-28T06:26:54Z","labels":{},"shape":{"virtual_cpu":4,"memory_megabytes":8192,"machine_arch":"amd64","os":"linux"}}]\\n' ;;
esac`);
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: {
        PROOFBOX_NSC: fake.path,
        PROOFBOX_NS_CREATE_TIMEOUT: "1s",
      },
    });
    // Then
    expect(result.stderr).toBe(
      "Namespace did not make the host in 1 s; deleted any half-made host. Try again\n",
    );
    expect(result.exitCode).toBe(125);
    const lines = logLines(fake.log);
    expect(
      lines.some((line) =>
        line.startsWith("list -o json --label proofbox.create-token="),
      ),
    ).toBe(true);
    expect(lines).toContain("destroy abc123def4567 --force");
  });

  it("Namespace down exits with its error and makes nothing", async () => {
    // Given: create fails with an Unavailable rpc error
    const fake = makeFakeNsc(`case "$1" in
auth) exit 0 ;;
create) printf 'Failed: rpc error: code = Unavailable desc = connection refused\\n' >&2; exit 1 ;;
list) printf 'null\\n' ;;
esac`);
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: { PROOFBOX_NSC: fake.path },
    });
    // Then
    expect(result.stderr).toBe(
      "Provider namespace failed: nsc create failed: rpc error: code = Unavailable desc = connection refused\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      logLines(fake.log).filter((line) => line.startsWith("destroy")),
    ).toEqual([]);
  });

  it("create --size 16x32 asks nsc for a 16x32 host", async () => {
    // Given: a fake nsc whose create answers a valid host id
    const fake = makeFakeNsc(`case "$1" in
auth) exit 0 ;;
create)
  prev=""; cidfile=""
  for a in "$@"; do
    [ "$prev" = "--cidfile" ] && cidfile="$a"
    prev="$a"
  done
  [ -n "$cidfile" ] && echo abc123def4567 > "$cidfile"
  printf '{"instance_id":"abc123def4567"}\\n' ;;
instance) printf 'Failed: rpc error\\n' >&2; exit 1 ;;
list) printf 'null\\n' ;;
destroy) exit 0 ;;
esac`);
    const env = makeEnv();
    // When
    await runCli(env, [...CREATE, "--size", "16x32"], {
      set: { PROOFBOX_NSC: fake.path },
    });
    // Then: whatever the run does next, nsc was asked for a 16x32 host
    expect(
      logLines(fake.log).some(
        (line) =>
          line.startsWith("create ") &&
          line.includes("--machine_type linux/amd64:16x32"),
      ),
    ).toBe(true);
  });

  it("exec with no ssh on PATH says to install an OpenSSH client", async () => {
    // Given: a PATH with no ssh and an nsc stub that answers port-forward
    // with a Listening line, then waits on stdin
    const binDir = mkdtempSync(join(tmpdir(), "proofbox-nossh-"));
    trackTempDir(binDir);
    const fake = makeFakeNsc(`case "$1 $2" in
"instance port-forward")
  printf 'Listening on 127.0.0.1:4321\\n'
  read -r _ ;;
esac`);
    const env = makeEnv();
    // When
    const start = performance.now();
    const result = await runCli(
      env,
      ["exec", "ns:abc123def4567", "--", "true"],
      {
        set: { PATH: binDir, PROOFBOX_NSC: fake.path },
      },
    );
    const millis = performance.now() - start;
    // Then
    expect(result.stderr).toBe(
      "ssh is not installed; install an OpenSSH client\n",
    );
    expect(result.exitCode).toBe(125);
    expect(millis).toBeLessThan(5000);
  });
});
