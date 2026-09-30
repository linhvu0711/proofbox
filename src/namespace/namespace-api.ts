import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type ComputeClient,
  createComputeClient,
  createRegionTransport,
} from "@namespacelabs/sdk/api";
import { extractClaims, fromBearerToken } from "@namespacelabs/sdk/auth";
import { LabelFilterEntry_LabelFilterOp } from "@namespacelabs/sdk/proto/namespace/stdlib/labels_pb";
import { Config, Effect, Option, Redacted } from "effect";
import {
  type BadLoginsFileError,
  type LoginExpiredError,
  type NotLoggedInError,
  ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenPermissionError,
  TokenRejectedError,
} from "../errors.ts";
import type { ProviderAccount, ProviderLogin } from "../provider.ts";
import { DEFAULT_REGION, hostName } from "./regions.ts";

export type ApiLoginError =
  | NotLoggedInError
  | LoginExpiredError
  | BadLoginsFileError;

export type ApiError =
  | ProviderError
  | ProviderLimitError
  | ProviderUnavailableError
  | SandboxGoneError
  | TokenRejectedError
  | TokenPermissionError;

// One Namespace instance as `list` reports it: its id and its labels as a
// name → value record.
export interface InstanceListed {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface LabelEntry {
  readonly name: string;
  readonly value: string;
}

// What a create asks the Compute API for; proofbox shapes it.
export interface CreateReq {
  readonly shape: {
    readonly os: string;
    readonly machineArch: string;
    readonly virtualCpu: number;
    readonly memoryMegabytes: number;
    readonly selectors: ReadonlyArray<LabelEntry>;
  };
  readonly labels: ReadonlyArray<LabelEntry>;
  readonly deadline: Date;
  readonly authorizedSshKeys: ReadonlyArray<string>;
}

export interface NamespaceApi {
  readonly create: (
    region: string,
    req: CreateReq,
  ) => Effect.Effect<string, ApiError | ApiLoginError>;
  readonly wait: (
    region: string,
    instanceId: string,
  ) => Effect.Effect<void, ApiError | ApiLoginError>;
  readonly destroy: (
    region: string,
    instanceId: string,
  ) => Effect.Effect<void, ApiError | ApiLoginError>;
  readonly extend: (
    region: string,
    instanceId: string,
    seconds: number,
  ) => Effect.Effect<void, ApiError | ApiLoginError>;
  readonly list: (
    region: string,
    labels: ReadonlyArray<LabelEntry>,
  ) => Effect.Effect<ReadonlyArray<InstanceListed>, ApiError | ApiLoginError>;
  readonly checkToken: (
    token: Redacted.Redacted<string>,
    region: Option.Option<string>,
  ) => Effect.Effect<
    ProviderAccount,
    TokenRejectedError | TokenPermissionError | ProviderUnavailableError
  >;
}

const UNREACHABLE =
  "Could not reach Namespace. Check your network and try again.";

export const unreachable = () =>
  new ProviderUnavailableError({
    provider: "namespace",
    reason: UNREACHABLE,
  });

// A refused create names the capacity it wanted; pull the clause that
// ends at the first `)` so the size is included.
const capacityClause = /ran out of capacity:[^)]*\)/;

// Maps a failed Compute call to the proofbox error: `call` is the service
// method name (`CreateInstance`), `host` the instance a `not_found` is
// about.
export const fromConnect =
  (
    call: string,
    host?: { readonly region: string; readonly instanceId: string },
  ) =>
  (cause: unknown): ApiError => {
    if (!(cause instanceof ConnectError)) {
      return unreachable();
    }
    if (cause.code === Code.Unauthenticated) {
      return new TokenRejectedError({ provider: "namespace" });
    }
    if (cause.code === Code.PermissionDenied) {
      return new TokenPermissionError({
        provider: "namespace",
        call: `ComputeService.${call}`,
      });
    }
    if (cause.code === Code.ResourceExhausted) {
      const found = capacityClause.exec(cause.rawMessage);
      return new ProviderLimitError({
        provider: "namespace",
        limit: found === null ? cause.rawMessage : found[0],
      });
    }
    if (cause.code === Code.NotFound && host !== undefined) {
      return new SandboxGoneError({
        id: `ns:${hostName(host.region, host.instanceId)}`,
      });
    }
    if (
      cause.code === Code.Unavailable ||
      cause.code === Code.DeadlineExceeded
    ) {
      return unreachable();
    }
    return new ProviderError({
      provider: "namespace",
      reason: `ComputeService.${call} failed: ${cause.rawMessage}`,
    });
  };

// The Compute API base URL for a region; `{region}` in
// PROOFBOX_NAMESPACE_COMPUTE_URL is replaced by the region.
const computeUrlTemplate = Config.string("PROOFBOX_NAMESPACE_COMPUTE_URL").pipe(
  Config.withDefault("https://{region}.compute.namespaceapis.com"),
);

export const makeNamespaceApi = (deps: {
  readonly login: ProviderLogin;
  readonly computeUrl?: Config.Config<string>;
}): NamespaceApi => {
  const template = deps.computeUrl ?? computeUrlTemplate;

  const clientFor = (region: string, token: Redacted.Redacted<string>) =>
    template.pipe(
      Effect.map(
        (url) =>
          createComputeClient({
            transport: createRegionTransport(region, {
              tokenSource: fromBearerToken(Redacted.value(token)),
              baseUrl: url.replaceAll("{region}", region),
            }),
          }) as ComputeClient,
      ),
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    );

  // The token comes from the login in hand, so every call sees the
  // freshest env or saved login.
  const loggedClient = (region: string) =>
    Effect.flatMap(deps.login, (hand) => clientFor(region, hand.token));

  const list = (region: string, labels: ReadonlyArray<LabelEntry>) =>
    Effect.gen(function* () {
      const client = yield* loggedClient(region);
      const labelFilter = labels.map((label) => ({
        name: label.name,
        value: label.value,
        op: LabelFilterEntry_LabelFilterOp.EQUAL,
      }));
      const found: InstanceListed[] = [];
      let cursor: Uint8Array = new Uint8Array();
      while (true) {
        const page = yield* Effect.tryPromise({
          try: () =>
            client.compute.listInstances({
              labelFilter,
              paginationCursor: cursor,
            }),
          catch: fromConnect("ListInstances"),
        });
        for (const instance of page.instances) {
          found.push({
            id: instance.instanceId,
            labels: Object.fromEntries(
              instance.labels.map((label) => [label.name, label.value]),
            ),
          });
        }
        if (page.paginationCursor.length === 0) {
          return found;
        }
        cursor = page.paginationCursor as Uint8Array<ArrayBuffer>;
      }
    });

  // A token proofbox does not even recognize as a Namespace token is
  // rejected without a call; else one listInstances checks it.
  const checkToken = (
    token: Redacted.Redacted<string>,
    region: Option.Option<string>,
  ) =>
    Effect.gen(function* () {
      const claims = extractClaims(Redacted.value(token));
      const tenantId = claims?.tenant_id;
      const exp = claims?.exp;
      if (typeof tenantId !== "string" || typeof exp !== "number") {
        return yield* new TokenRejectedError({ provider: "namespace" });
      }
      const client = yield* clientFor(
        Option.getOrElse(region, () => DEFAULT_REGION),
        token,
      ).pipe(Effect.mapError(() => unreachable()));
      yield* Effect.tryPromise({
        try: () => client.compute.listInstances({ maxEntries: 1n }),
        catch: fromConnect("ListInstances"),
      }).pipe(
        // checkToken's failure ways stay narrow; an odd answer reads as
        // unreachable.
        Effect.mapError((error) =>
          error instanceof TokenRejectedError ||
          error instanceof TokenPermissionError ||
          error instanceof ProviderUnavailableError
            ? error
            : unreachable(),
        ),
      );
      return {
        account: tenantId,
        expiresAt: new Date(exp * 1000),
      } satisfies ProviderAccount;
    });

  const create = (region: string, req: CreateReq) =>
    Effect.gen(function* () {
      const client = yield* loggedClient(region);
      const made = yield* Effect.tryPromise({
        try: () =>
          client.compute.createInstance({
            shape: {
              os: req.shape.os,
              machineArch: req.shape.machineArch,
              virtualCpu: req.shape.virtualCpu,
              memoryMegabytes: req.shape.memoryMegabytes,
              selectors: req.shape.selectors.map((label) => ({
                name: label.name,
                value: label.value,
              })),
            },
            labels: req.labels.map((label) => ({
              name: label.name,
              value: label.value,
            })),
            deadline: timestampFromDate(req.deadline),
            experimental: {
              authorizedSshKeys: [...req.authorizedSshKeys],
            },
            documentedPurpose: "proofbox Sandbox",
          }),
        catch: fromConnect("CreateInstance"),
      });
      const instanceId = made.metadata?.instanceId;
      if (instanceId === undefined || instanceId === "") {
        return yield* new ProviderError({
          provider: "namespace",
          reason: "ComputeService.CreateInstance made no instance id",
        });
      }
      return instanceId;
    });

  const wait = (region: string, instanceId: string) =>
    Effect.gen(function* () {
      const client = yield* loggedClient(region);
      yield* Effect.tryPromise({
        try: () => client.compute.waitInstanceSync({ instanceId }),
        catch: fromConnect("WaitInstanceSync", { region, instanceId }),
      });
    });

  const destroy = (region: string, instanceId: string) =>
    Effect.gen(function* () {
      const client = yield* loggedClient(region);
      yield* Effect.tryPromise({
        try: () => client.compute.destroyInstance({ instanceId }),
        catch: fromConnect("DestroyInstance", { region, instanceId }),
      });
    });

  const extend = (region: string, instanceId: string, seconds: number) =>
    Effect.gen(function* () {
      const client = yield* loggedClient(region);
      yield* Effect.tryPromise({
        try: () =>
          client.compute.extendInstance({
            instanceId,
            ensureMinimum: { seconds: BigInt(seconds), nanos: 0 },
          }),
        catch: fromConnect("ExtendInstance", { region, instanceId }),
      });
    });

  return { create, wait, destroy, extend, list, checkToken };
};
