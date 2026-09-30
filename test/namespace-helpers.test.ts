import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";
import { startFakeNamespace } from "./support/fake-namespace-api.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const TOKEN =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig";

const INSTANCE = "abc123def4567";

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-helpers-"));
  trackTempDir(dir);
  return dir;
};

// A name's Max-life cap file, holding the epoch second it ends.
const capFile = (runtime: string, name: string, at: number) =>
  writeFileSync(join(runtime, `ns-${name}.max-life`), `${at}\n`, {
    mode: 0o600,
  });

const runHelper = (
  script: string,
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((resolve) => {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...env,
    };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) {
        delete childEnv[key];
      }
    }
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--", script, ...args],
      { cwd: repoRoot, env: childEnv, timeout: 60_000 },
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

afterAll(cleanupEnvs);

describe("Namespace helpers", () => {
  it("extend-main on the env login pushes the deadline through the API", async () => {
    const ns = await startFakeNamespace(() => ({ json: {} }));
    const runtime = tempDir();
    const home = tempDir();
    capFile(runtime, INSTANCE, Math.floor(Date.now() / 1000) + 3600);
    const result = await runHelper(
      "src/namespace/extend-main.ts",
      ["us", INSTANCE, "60"],
      {
        PROOFBOX_RUNTIME_DIR: runtime,
        PROOFBOX_NAMESPACE_TOKEN: TOKEN,
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        HOME: home,
      },
    );
    await ns.close();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(ns.calls).toHaveLength(1);
    expect(ns.calls[0]).toMatchObject({
      region: "us",
      method: "ExtendInstance",
      body: { instanceId: INSTANCE, ensureMinimum: "60s" },
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("expire-main on a saved login destroys the host through the API", async () => {
    const ns = await startFakeNamespace(() => ({ json: {} }));
    const runtime = tempDir();
    const home = tempDir();
    const logins = join(home, ".config", "proofbox", "logins.json");
    mkdirSync(dirname(logins), { recursive: true });
    writeFileSync(
      logins,
      `${JSON.stringify({
        namespace: {
          way: "token",
          token: TOKEN,
          account: "tnt_test",
          expiresAt: "3000-01-01T00:00:00.000Z",
          region: "us",
        },
      })}\n`,
      { mode: 0o600 },
    );
    capFile(runtime, INSTANCE, Math.floor(Date.now() / 1000) + 3600);
    const result = await runHelper(
      "src/namespace/expire-main.ts",
      ["us", INSTANCE, `${Math.floor(Date.now() / 1000)}`],
      {
        PROOFBOX_RUNTIME_DIR: runtime,
        PROOFBOX_NAMESPACE_TOKEN: undefined,
        PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
        HOME: home,
      },
    );
    await ns.close();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(ns.calls).toHaveLength(1);
    expect(ns.calls[0]).toMatchObject({
      region: "us",
      method: "DestroyInstance",
      body: { instanceId: INSTANCE },
      authorization: `Bearer ${TOKEN}`,
    });
  });
});
