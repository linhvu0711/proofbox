import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type CliEnv, cleanupEnvs, makeEnv, runCli } from "./support/cli.ts";

const nscBin = () => process.env.PROOFBOX_NSC ?? "nsc";

const nsc = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(nscBin(), args, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      }
    });
  });

describe("Namespace Provider", () => {
  const hosts: string[] = [];

  afterEach(async () => {
    for (const id of hosts.splice(0)) {
      await nsc(["destroy", id, "--force"]).catch(() => {});
    }
    cleanupEnvs();
  });

  const create = async (env: CliEnv, extra: ReadonlyArray<string> = []) => {
    const result = await runCli(env, [
      "create",
      "--os",
      "linux",
      "--provider",
      "namespace",
      ...extra,
    ]);
    const id = result.stdout.trim();
    if (/^ns:[a-z0-9]+$/.test(id)) {
      hosts.push(id.slice("ns:".length));
    }
    return result;
  };

  it("create prints an ns Sandbox id with the desktop up", async () => {
    // Given: a real Namespace account (nsc auth check-login exits 0)
    const env = makeEnv({ docker: true, namespace: true });
    // When
    const created = await create(env);
    const id = created.stdout.trim();
    const dimensions = await runCli(env, [
      "exec",
      id,
      "--",
      "sh",
      "-c",
      "xdpyinfo | grep dimensions",
    ]);
    const chromium = await runCli(env, [
      "exec",
      id,
      "--",
      "chromium",
      "--version",
    ]);
    // Then
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toMatch(/^ns:[a-z0-9]+\n$/);
    expect(dimensions.stdout).toContain("1440x900 pixels");
    expect(chromium.stdout).toMatch(/^Chromium \d+\./);
  });

  it("exec runs as the app user", async () => {
    // Given: a created ns: Sandbox
    const env = makeEnv({ docker: true, namespace: true });
    const created = await create(env);
    const id = created.stdout.trim();
    // When
    const whoami = await runCli(env, ["exec", id, "--", "id", "-un"]);
    // Then
    expect(whoami.stdout).toBe("app\n");
    expect(whoami.exitCode).toBe(0);
  });
});
