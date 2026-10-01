// Live Namespace calls for the .namespace.test.ts suites: `liveInstances`
// lists every host the token can see across the known regions, and
// `destroyHost` deletes one, best effort.

import {
  type ComputeClient,
  createComputeClient,
  createRegionTransport,
} from "@namespacelabs/sdk/api";
import { fromBearerToken } from "@namespacelabs/sdk/auth";
import type { InstanceShape } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import { KNOWN_REGIONS } from "../../src/namespace/regions.ts";

export interface LiveInstance {
  readonly id: string;
  readonly region: string;
  readonly shape?: InstanceShape | undefined;
}

const clientFor = (region: string): ComputeClient => {
  const token = process.env.PROOFBOX_NAMESPACE_TOKEN;
  if (token === undefined) {
    throw new Error("PROOFBOX_NAMESPACE_TOKEN is not set");
  }
  const baseUrl = (
    process.env.PROOFBOX_NAMESPACE_COMPUTE_URL ??
    "https://{region}.compute.namespaceapis.com"
  ).replaceAll("{region}", region);
  return createComputeClient({
    transport: createRegionTransport(region, {
      tokenSource: fromBearerToken(token),
      baseUrl,
    }),
  }) as ComputeClient;
};

const listIn = async (region: string): Promise<Array<LiveInstance>> => {
  const client = clientFor(region);
  const found: Array<LiveInstance> = [];
  let cursor = new Uint8Array();
  for (;;) {
    const page = await client.compute.listInstances({
      paginationCursor: cursor,
    });
    for (const instance of page.instances) {
      found.push({ id: instance.instanceId, region, shape: instance.shape });
    }
    if (page.paginationCursor.length === 0) {
      return found;
    }
    cursor = page.paginationCursor as Uint8Array<ArrayBuffer>;
  }
};

export const liveInstances = async (): Promise<Array<LiveInstance>> => {
  const seen = new Map<string, LiveInstance>();
  for (const region of KNOWN_REGIONS) {
    for (const instance of await listIn(region)) {
      if (!seen.has(instance.id)) {
        seen.set(instance.id, instance);
      }
    }
  }
  return [...seen.values()];
};

export const destroyHost = async (
  region: string,
  id: string,
): Promise<void> => {
  try {
    await clientFor(region).compute.destroyInstance({ instanceId: id });
  } catch {
    // Best effort: a host already gone must not fail the cleanup.
  }
};
