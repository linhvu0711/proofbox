import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";
import {
  type FakeNamespace,
  startFakeNamespace,
} from "./support/fake-namespace-api.ts";
import { makeFakeNsc } from "./support/fake-nsc.ts";

const TOKEN =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig";

const CREATE = ["create", "--os", "linux", "--provider", "namespace"];

const nsEnv = (ns: FakeNamespace) => ({
  PROOFBOX_NAMESPACE_TOKEN: TOKEN,
  PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
});

const nsFiles = (runtime: string) =>
  readdirSync(runtime).filter((name) => name.startsWith("ns-"));

describe("Namespace errors", () => {
  const servers: Array<FakeNamespace> = [];
  const fakeNamespace = async (
    answer: Parameters<typeof startFakeNamespace>[0],
  ) => {
    const server = await startFakeNamespace(answer);
    servers.push(server);
    return server;
  };

  afterEach(async () => {
    cleanupEnvs();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("create with no Namespace login says how to log in", async () => {
    // Given: no env token and no saved login
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE);
    // Then
    expect(result.stderr).toBe(
      "Not logged in to namespace. Run: proofbox auth login namespace\n",
    );
    expect(result.exitCode).toBe(125);
    expect(nsFiles(env.runtime)).toEqual([]);
  });

  it("a Namespace limit exits with the limit and leaves nothing", async () => {
    // Given: Namespace refuses the create for capacity
    const ns = await fakeNamespace((call) =>
      call.method === "CreateInstance"
        ? {
            error: {
              code: "resource_exhausted",
              message:
                "ran out of capacity: 1st instance limit (want 64 vCPU 128 GB RAM; used all of 32 vCPU 128 GB RAM) https://namespace.so/e/resource-limits",
            },
          }
        : { json: {} },
    );
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, { set: nsEnv(ns) });
    // Then
    expect(result.stderr).toBe(
      "Namespace refused the Sandbox: ran out of capacity: 1st instance limit (want 64 vCPU 128 GB RAM; used all of 32 vCPU 128 GB RAM); nothing was created. Delete a Sandbox or use a smaller --size\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      ns.calls.filter((call) => call.method === "DestroyInstance"),
    ).toEqual([]);
    expect(nsFiles(env.runtime)).toEqual([]);
  });

  it("a Namespace macOS limit exits with the limit and leaves nothing", async () => {
    // Given: Namespace refuses the create for macOS capacity
    const ns = await fakeNamespace((call) =>
      call.method === "CreateInstance"
        ? {
            error: {
              code: "resource_exhausted",
              message:
                "ran out of capacity: 1st instance limit (want 6 vCPU 14 GB RAM; used all of 6 vCPU 14 GB RAM) https://namespace.so/e/resource-limits",
            },
          }
        : { json: {} },
    );
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["create", "--os", "macos", "--provider", "namespace"],
      { set: nsEnv(ns) },
    );
    // Then
    expect(result.stderr).toBe(
      "Namespace refused the Sandbox: ran out of capacity: 1st instance limit (want 6 vCPU 14 GB RAM; used all of 6 vCPU 14 GB RAM); nothing was created. Delete a Sandbox or use a smaller --size\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      ns.calls.filter((call) => call.method === "DestroyInstance"),
    ).toEqual([]);
    expect(nsFiles(env.runtime)).toEqual([]);
  });

  it("a create that times out deletes the half-made host", async () => {
    // Given: create answers but wait never does; list finds the host
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "WaitInstanceSync") {
        return "hang";
      }
      if (call.method === "ListInstances") {
        return { json: { instances: [{ instanceId: "abc123def4567" }] } };
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: { ...nsEnv(ns), PROOFBOX_NS_CREATE_TIMEOUT: "1s" },
    });
    // Then
    expect(result.stderr).toBe(
      "Namespace did not make the host in 1 s; deleted any half-made host. Try again\n",
    );
    expect(result.exitCode).toBe(125);
    const sweep = ns.calls.find((call) => call.method === "ListInstances");
    expect(JSON.stringify(sweep?.body)).toContain("proofbox.create-token");
    expect(
      ns.calls.some(
        (call) =>
          call.method === "DestroyInstance" &&
          call.region === "us" &&
          JSON.stringify(call.body).includes("abc123def4567"),
      ),
    ).toBe(true);
  });

  it("create when Namespace cannot be reached says to check the network", async () => {
    // Given: makeEnv points the Compute API at port 9
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, {
      set: { PROOFBOX_NAMESPACE_TOKEN: TOKEN },
    });
    // Then
    expect(result.stderr).toBe(
      "Could not reach Namespace. Check your network and try again.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(nsFiles(env.runtime)).toEqual([]);
  });

  it("create with a token that cannot manage instances names the permission", async () => {
    // Given: Namespace denies every call
    const ns = await fakeNamespace(() => ({
      error: { code: "permission_denied", message: "denied" },
    }));
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, { set: nsEnv(ns) });
    // Then
    expect(result.stderr).toBe(
      "This Namespace token lacks permission for ComputeService.CreateInstance. Use a token that can manage instances.\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("create --size 16x32 asks Namespace for a 16 CPU 32768 MB host", async () => {
    // Given: create answers but wait hangs, so the run ends fast
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "WaitInstanceSync") {
        return "hang";
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    await runCli(env, [...CREATE, "--size", "16x32"], {
      set: { ...nsEnv(ns), PROOFBOX_NS_CREATE_TIMEOUT: "1s" },
    });
    // Then: whatever the run does next, Namespace was asked for a
    // 16 CPU 32768 MB host
    const created = ns.calls.find((call) => call.method === "CreateInstance");
    expect(created?.region).toBe("us");
    const body = created?.body as { shape?: unknown } | undefined;
    expect(body?.shape).toMatchObject({
      os: "linux",
      machineArch: "amd64",
      virtualCpu: 16,
      memoryMegabytes: 32768,
    });
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
      ["exec", "ns:us:abc123def4567", "--", "true"],
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
