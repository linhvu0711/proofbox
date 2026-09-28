import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

// Real Namespace Macs cost money and the workspace quota holds one 6x14 Mac
// at a time, so each describe makes one Mac, shares it, and deletes it.

const nscBin = () => process.env.PROOFBOX_NSC ?? "nsc";

const destroy = (id: string): Promise<void> =>
  new Promise((resolve) => {
    execFile(nscBin(), ["destroy", id, "--force"], () => resolve());
  });

const createMac = async (env: CliEnv, extra: ReadonlyArray<string> = []) => {
  const result = await runCli(env, [
    "create",
    "--os",
    "macos",
    "--provider",
    "namespace",
    ...extra,
  ]);
  return { result, id: result.stdout.trim() };
};

describe("Namespace macOS Provider", () => {
  let env: CliEnv;
  let created: Awaited<ReturnType<typeof createMac>>;
  let id: string;

  beforeAll(async () => {
    env = makeEnv({ namespace: true });
    created = await createMac(env);
    id = created.id;
  });

  afterAll(async () => {
    if (/^ns:[a-z0-9]+$/.test(id)) {
      await runCli(env, ["delete", id]);
      await destroy(id.slice("ns:".length));
    }
    cleanupEnvs();
  });

  it("create --os macos prints an ns id for a prepared macOS 26 Mac", async () => {
    // Given: the Mac from beforeAll
    // When
    const version = await runCli(env, [
      "exec",
      id,
      "--",
      "sw_vers",
      "-productVersion",
    ]);
    // Then
    expect(created.result.stdout).toMatch(/^ns:[a-z0-9]+\n$/);
    expect(created.result.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^26\./);
  });

  it("live and record on a Mac are refused until #15", async () => {
    // Given: the Mac from beforeAll
    // When
    const live = await runCli(env, ["live", id]);
    const record = await runCli(env, ["record", "start", id]);
    // Then
    expect(live.stderr).toBe(
      "Provider namespace lacks the Capability live-view on macos; no Live view was opened\n",
    );
    expect(live.exitCode).toBe(125);
    expect(record.stderr).toBe(
      "Provider namespace lacks the Capability recording on macos; no Recording was started\n",
    );
    expect(record.exitCode).toBe(125);
  });
});

describe("Namespace macOS Provider at 6x14", () => {
  it("create --os macos --size 6x14 makes a 6-CPU Mac", async () => {
    // Given: no other Mac is up (the quota holds one 6x14 Mac)
    const env = makeEnv({ namespace: true });
    try {
      // When
      const { result, id } = await createMac(env, ["--size", "6x14"]);
      try {
        const cpus = await runCli(env, [
          "exec",
          id,
          "--",
          "sysctl",
          "-n",
          "hw.ncpu",
        ]);
        // Then
        expect(result.exitCode).toBe(0);
        expect(cpus.stdout).toBe("6\n");
      } finally {
        if (/^ns:[a-z0-9]+$/.test(id)) {
          await runCli(env, ["delete", id]);
          await destroy(id.slice("ns:".length));
        }
      }
    } finally {
      cleanupEnvs();
    }
  });
});
