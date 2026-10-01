import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { pushHostLife } from "./host-life.ts";
import { makeNamespaceApi } from "./namespace-api.ts";
import { namespaceLogin } from "./namespace-login.ts";

const region = process.argv[2];
const instanceId = process.argv[3];
const seconds = Number(process.argv[4]);

(region === undefined ||
instanceId === undefined ||
!Number.isFinite(seconds) ||
seconds <= 0
  ? Effect.void
  : pushHostLife(
      makeNamespaceApi({ login: namespaceLogin }),
      { name: instanceId, region },
      seconds,
    )
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
