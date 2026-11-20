import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { makeNamespaceApi, type NamespaceApi } from "./namespace-api.ts";
import { makeNamespaceLogin } from "./namespace-login.ts";

export interface HostJob {
  readonly region: string;
  readonly instanceId: string;
  readonly value: number;
  readonly api: NamespaceApi;
}

// The work of a detached process that acts on one Namespace host. Its argv
// is <region> <instance id> <number above 0>; any other argv does nothing.
export const hostJob = Effect.fn("hostJob.hostJob")(function* <E, R>(
  run: (job: HostJob) => Effect.Effect<void, E, R>,
) {
  const region = process.argv[2];
  const instanceId = process.argv[3];
  const value = Number(process.argv[4]);
  if (
    region === undefined ||
    instanceId === undefined ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* run({
    region,
    instanceId,
    value,
    api: makeNamespaceApi({ login: makeNamespaceLogin(fs) }),
  });
});
