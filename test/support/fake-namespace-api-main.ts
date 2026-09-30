// Standalone fake Compute API for the UI videos: `node
// fake-namespace-api-main.ts <mode> <port>`. A mode answers every call
// one way: "capacity" refuses a create on capacity, "denied" refuses
// every call on permission, "rejected" rejects every token, "login"
// plays the sign-in calls and the login page and answers `{}` to
// every Compute call, "ssh" lists three walk instances and answers
// GetSSHConfig the way each walk needs it.
import {
  type FakeNamespaceAnswer,
  type FakeNamespaceCall,
  fakeSignin,
  startFakeNamespace,
} from "./fake-namespace-api.ts";

const [mode, portText] = process.argv.slice(2);
const port = Number(portText);

const capacity =
  "ran out of capacity: 1st instance limit (want 64 vCPU 128 GB RAM; used all of 32 vCPU 128 GB RAM) https://namespace.so/e/resource-limits";

const instanceId = (call: FakeNamespaceCall): string =>
  typeof call.body === "object" &&
  call.body !== null &&
  "instanceId" in call.body
    ? String((call.body as { instanceId?: unknown }).instanceId ?? "")
    : "";

const sshConfig = (username: string, endpoint: string) => ({
  json: {
    username,
    endpoint,
    sshPrivateKey: Buffer.from("key").toString("base64"),
    sshHostKeys: [
      Buffer.from(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ).toString("base64"),
    ],
  },
});

const answer = (call: FakeNamespaceCall): FakeNamespaceAnswer => {
  if (mode === "ssh") {
    if (call.method === "ListInstances") {
      return {
        json: {
          instances: [
            { instanceId: "abc123def4567" },
            { instanceId: "def456abc1234" },
            { instanceId: "fed789cba4321" },
          ],
        },
      };
    }
    if (call.method === "GetSSHConfig") {
      const id = instanceId(call);
      if (id === "abc123def4567") {
        return {
          error: {
            code: "failed_precondition",
            message: "instance is not ready",
          },
        };
      }
      if (id === "def456abc1234") {
        return sshConfig(id, "ssh.invalid");
      }
      if (id === "fed789cba4321") {
        return sshConfig("git", "github.com");
      }
    }
    return { json: {} };
  }
  if (mode === "capacity") {
    return call.method === "CreateInstance"
      ? { error: { code: "resource_exhausted", message: capacity } }
      : { json: {} };
  }
  if (mode === "denied") {
    return { error: { code: "permission_denied", message: "denied" } };
  }
  if (mode === "rejected") {
    return { error: { code: "unauthenticated", message: "bad token" } };
  }
  return { json: {} };
};

const server = await startFakeNamespace(
  answer,
  port,
  mode === "login" ? fakeSignin() : undefined,
);
console.log(`fake-namespace-api ${mode} on ${server.url}`);
