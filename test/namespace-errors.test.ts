import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";
import {
  type FakeNamespace,
  startFakeNamespace,
} from "./support/fake-namespace-api.ts";

const TOKEN =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig";

const CREATE = ["create", "--os", "linux", "--provider", "namespace"];
const CREATE_MACOS = ["create", "--os", "macos", "--provider", "namespace"];

const nsEnv = (ns: FakeNamespace) => ({
  PROOFBOX_NAMESPACE_TOKEN: TOKEN,
  PROOFBOX_NAMESPACE_COMPUTE_URL: ns.url,
  // The fake keeps refusing, so the limit would otherwise take the full
  // retry window.
  PROOFBOX_NS_LIMIT_WAIT: "0s",
});

const nsFiles = (runtime: string) =>
  readdirSync(runtime).filter((name) => name.startsWith("ns-"));

// How many SSH masters (`ssh -M -N …`) a fake ssh that logs its argv was
// asked to start; the `-O check` and `-O exit` calls do not count.
const masterStarts = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("-M ")).length;

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

  it("exec on a Mac made by an older proofbox says to delete it and create a new one", async () => {
    // Given
    const ns = await fakeNamespace(() => ({ json: {} }));
    const env = makeEnv();
    writeFileSync(join(env.runtime, "ns-us:abc123def4567.os"), "macos");
    // When
    const result = await runCli(
      env,
      ["exec", "ns:us:abc123def4567", "--", "true"],
      { set: nsEnv(ns) },
    );
    // Then
    expect({ stderr: result.stderr, exitCode: result.exitCode }).toEqual({
      stderr:
        "Sandbox ns:us:abc123def4567 was made by an older proofbox, or on another machine, so this machine cannot reach its sshd. Delete it and create a new one. Run: proofbox delete ns:us:abc123def4567\n",
      exitCode: 125,
    });
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

  it("Ctrl-C while Namespace makes the host deletes it", async () => {
    // Given: create answers; wait sends Ctrl-C and never answers; list
    // finds the host by its create token
    let interrupt = () => {};
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "WaitInstanceSync") {
        interrupt();
        return "hang";
      }
      if (call.method === "ListInstances") {
        return { json: { instances: [{ instanceId: "abc123def4567" }] } };
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE_MACOS, {
      set: { ...nsEnv(ns), PROOFBOX_NS_CREATE_TIMEOUT: "60s" },
      onSpawn: (send) => {
        interrupt = send;
      },
    });
    // Then: the sweep found the host by its token and deleted it
    expect({
      methods: ns.calls.map((call) => call.method),
      sweep: JSON.stringify(
        ns.calls.find((call) => call.method === "ListInstances")?.body,
      ).includes("proofbox.create-token"),
      destroyed: ns.calls
        .filter((call) => call.method === "DestroyInstance")
        .map((call) => ({ region: call.region, body: call.body })),
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      methods: [
        "CreateInstance",
        "WaitInstanceSync",
        "ListInstances",
        "DestroyInstance",
      ],
      sweep: true,
      destroyed: [{ region: "us", body: { instanceId: "abc123def4567" } }],
      stderr: "",
      exitCode: 125,
    });
  });

  it("Ctrl-C after Namespace made the host still deletes it", async () => {
    // Given: the host is made; the SSH config call sends Ctrl-C and never
    // answers
    let interrupt = () => {};
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "GetSSHConfig") {
        interrupt();
        return "hang";
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE_MACOS, {
      set: { ...nsEnv(ns), PROOFBOX_NS_CREATE_TIMEOUT: "60s" },
      onSpawn: (send) => {
        interrupt = send;
      },
    });
    // Then: the host was deleted by its id, with no sweep
    expect({
      listed: ns.calls.some((call) => call.method === "ListInstances"),
      destroyed: ns.calls
        .filter((call) => call.method === "DestroyInstance")
        .map((call) => call.body),
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      listed: false,
      destroyed: [{ instanceId: "abc123def4567" }],
      stderr: "",
      exitCode: 125,
    });
  });

  it("Ctrl-C says to run list when the host cannot be deleted", async () => {
    // Given: as a Ctrl-C during the wait, but the sweep's list fails
    let interrupt = () => {};
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "WaitInstanceSync") {
        interrupt();
        return "hang";
      }
      if (call.method === "ListInstances") {
        return { error: { code: "unavailable", message: "down" } };
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE_MACOS, {
      set: { ...nsEnv(ns), PROOFBOX_NS_CREATE_TIMEOUT: "60s" },
      onSpawn: (send) => {
        interrupt = send;
      },
    });
    // Then
    expect({
      stderr: result.stderr,
      destroyed: ns.calls.some((call) => call.method === "DestroyInstance"),
      exitCode: result.exitCode,
    }).toEqual({
      stderr:
        "proofbox: could not delete the host this create started; it may be left. Run: proofbox list\n",
      destroyed: false,
      exitCode: 125,
    });
  });

  it("delete of an Unfinished Sandbox destroys its host", async () => {
    // Given: Namespace lists a Mac host that never got its Sandbox state
    const ns = await fakeNamespace((call) =>
      call.method === "ListInstances"
        ? {
            json: {
              instances: [
                {
                  instanceId: "abc123def4567",
                  labels: [{ name: "proofbox.os", value: "macos" }],
                },
              ],
            },
          }
        : { json: {} },
    );
    const env = makeEnv();
    // When
    const result = await runCli(env, ["delete", "ns:us:abc123def4567"], {
      set: nsEnv(ns),
    });
    // Then
    expect({
      stdout: result.stdout,
      destroyed: ns.calls
        .filter((call) => call.method === "DestroyInstance")
        .map((call) => call.body),
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "Deleted ns:us:abc123def4567\n",
      destroyed: [{ instanceId: "abc123def4567" }],
      exitCode: 0,
    });
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

  it("create when the SSH config call is denied deletes the new host", async () => {
    // Given: Namespace answers create and wait but denies GetSSHConfig
    const ns = await fakeNamespace((call) => {
      if (call.method === "CreateInstance") {
        return { json: { metadata: { instanceId: "abc123def4567" } } };
      }
      if (call.method === "GetSSHConfig") {
        return { error: { code: "permission_denied", message: "denied" } };
      }
      return { json: {} };
    });
    const env = makeEnv();
    // When
    const result = await runCli(env, CREATE, { set: nsEnv(ns) });
    // Then: the new host was deleted before the failure surfaced
    expect(result.stderr).toBe(
      "This Namespace token lacks permission for ComputeService.GetSSHConfig. Use a token that can manage instances.\n",
    );
    expect(result.exitCode).toBe(125);
    expect(
      ns.calls.find(
        (call) => call.method === "DestroyInstance" && call.region === "us",
      )?.body,
    ).toEqual({ instanceId: "abc123def4567" });
  });

  it("exec with no ssh on PATH says to install an OpenSSH client", async () => {
    // Given: a PATH with no ssh; the Compute API answers GetSSHConfig
    const ns = await fakeNamespace((call) =>
      call.method === "GetSSHConfig"
        ? {
            json: {
              username: "abc123def4567",
              endpoint: "127.0.0.1",
              sshPrivateKey: Buffer.from("key").toString("base64"),
              sshHostKeys: [Buffer.from("host-key").toString("base64")],
            },
          }
        : { json: {} },
    );
    const binDir = mkdtempSync(join(tmpdir(), "proofbox-nossh-"));
    trackTempDir(binDir);
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["exec", "ns:us:abc123def4567", "--", "true"],
      {
        set: {
          PATH: binDir,
          ...nsEnv(ns),
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "ssh is not installed; install an OpenSSH client\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("exec when GetSSHConfig fails names the Sandbox", async () => {
    // Given: the Compute API refuses GetSSHConfig for the Sandbox
    const ns = await fakeNamespace((call) =>
      call.method === "GetSSHConfig"
        ? {
            error: {
              code: "failed_precondition",
              message: "instance is not ready",
            },
          }
        : { json: {} },
    );
    const binDir = mkdtempSync(join(tmpdir(), "proofbox-nossh-"));
    trackTempDir(binDir);
    const env = makeEnv();
    // When
    const result = await runCli(
      env,
      ["exec", "ns:us:abc123def4567", "--", "true"],
      {
        set: {
          PATH: binDir,
          ...nsEnv(ns),
        },
      },
    );
    // Then
    expect(result.stderr).toBe(
      "Provider namespace failed: could not get SSH access to Sandbox ns:us:abc123def4567 (ComputeService.GetSSHConfig failed: instance is not ready); try again in a minute\n",
    );
    expect(result.exitCode).toBe(125);
  });

  it("exec when ssh cannot connect names the Sandbox", async () => {
    // Given: an ssh that cannot resolve the gateway, and the Compute API
    // answers GetSSHConfig and ListInstances
    const ns = await fakeNamespace((call) => {
      if (call.method === "GetSSHConfig") {
        return {
          json: {
            username: "abc123def4567",
            endpoint: "ssh.invalid",
            sshPrivateKey: Buffer.from("key").toString("base64"),
            sshHostKeys: [Buffer.from("host-key").toString("base64")],
          },
        };
      }
      return call.method === "ListInstances"
        ? { json: { instances: [{ instanceId: "abc123def4567" }] } }
        : { json: {} };
    });
    const env = makeEnv();
    const log = join(env.runtime, "ssh.log");
    const binDir = mkdtempSync(join(tmpdir(), "proofbox-nossh-"));
    trackTempDir(binDir);
    writeFileSync(
      join(binDir, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho "ssh: Could not resolve hostname ssh.invalid: Name or service not known" >&2\nexit 255\n`,
      { mode: 0o755 },
    );
    // When
    const result = await runCli(
      env,
      ["exec", "ns:us:abc123def4567", "--", "true"],
      {
        set: {
          PATH: binDir,
          PROOFBOX_NS_LINK_WAIT: "0s",
          ...nsEnv(ns),
        },
      },
    );
    // Then: one try, since a 0s link wait makes the first failure final
    expect({
      stderr: result.stderr,
      exitCode: result.exitCode,
      masterStarts: masterStarts(log),
    }).toEqual({
      stderr:
        "Could not connect to Sandbox ns:us:abc123def4567 over SSH (ssh: Could not resolve hostname ssh.invalid: Name or service not known). Try again in a minute.\n",
      exitCode: 125,
      masterStarts: 1,
    });
  });

  it("exec when the Sandbox host key does not match refuses at once", async () => {
    // Given: an ssh whose host key check fails, and the Compute API
    // answers GetSSHConfig and ListInstances
    const ns = await fakeNamespace((call) => {
      if (call.method === "GetSSHConfig") {
        return {
          json: {
            username: "abc123def4567",
            endpoint: "ssh.invalid",
            sshPrivateKey: Buffer.from("key").toString("base64"),
            sshHostKeys: [Buffer.from("host-key").toString("base64")],
          },
        };
      }
      return call.method === "ListInstances"
        ? { json: { instances: [{ instanceId: "abc123def4567" }] } }
        : { json: {} };
    });
    const env = makeEnv();
    const log = join(env.runtime, "ssh.log");
    const binDir = mkdtempSync(join(tmpdir(), "proofbox-nossh-"));
    trackTempDir(binDir);
    writeFileSync(
      join(binDir, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho "Host key verification failed." >&2\nexit 255\n`,
      { mode: 0o755 },
    );
    // When: the link wait would allow retries, so a retried refusal shows
    // as more than one master start
    const result = await runCli(
      env,
      ["exec", "ns:us:abc123def4567", "--", "true"],
      {
        set: {
          PATH: binDir,
          PROOFBOX_NS_LINK_WAIT: "2s",
          ...nsEnv(ns),
        },
      },
    );
    // Then
    expect({
      stderr: result.stderr,
      exitCode: result.exitCode,
      masterStarts: masterStarts(log),
    }).toEqual({
      stderr:
        "Refused to connect to Sandbox ns:us:abc123def4567: its SSH host key does not match the key Namespace gave. Run: proofbox delete ns:us:abc123def4567\n",
      exitCode: 125,
      masterStarts: 1,
    });
  });
});
