// Standalone fake Compute API for the UI videos: `node
// fake-namespace-api-main.ts <mode> <port>`. A mode answers every call
// one way: "capacity" refuses a create on capacity, "denied" refuses
// every call on permission, "rejected" rejects every token, "login"
// plays the sign-in calls and the login page and answers `{}` to
// every Compute call.
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

const answer = (call: FakeNamespaceCall): FakeNamespaceAnswer => {
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
