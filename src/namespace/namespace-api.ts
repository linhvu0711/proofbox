import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  createComputeClient,
  createGlobalTransport,
  createIAMClient,
  createRegionTransport,
  createRegistryClient,
} from "@namespacelabs/sdk/api";
import { extractClaims, fromBearerToken } from "@namespacelabs/sdk/auth";
import { InstanceMetadata_Status } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import { LabelFilterEntry_LabelFilterOp } from "@namespacelabs/sdk/proto/namespace/stdlib/labels_pb";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import {
  type BadLoginsFileError,
  LoginExpiredError,
  type NotLoggedInError,
  ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  SandboxGoneError,
  TokenDeniedError,
  TokenPermissionError,
  TokenRejectedError,
} from "../errors.ts";
import type {
  ProviderAccount,
  ProviderLogin,
  TokenRequest,
} from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { DEFAULT_REGION } from "./regions.ts";

export type ApiLoginError =
  | NotLoggedInError
  | LoginExpiredError
  | BadLoginsFileError
  | ProviderUnavailableError;

export type ApiError =
  | ProviderError
  | ProviderLimitError
  | ProviderUnavailableError
  | SandboxGoneError
  | TokenRejectedError
  | TokenPermissionError;

// One Namespace instance as `list` reports it: its id, its labels as a
// name → value record, and the continent it runs on — every endpoint's
// list is global, so the continent, not the queried region, names where
// the instance lives. `starting` is true while Namespace still makes it.
export interface InstanceListed {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly region?: string | undefined;
  readonly createdAt?: Date | undefined;
  readonly starting?: boolean | undefined;
}

export interface LabelEntry {
  readonly name: string;
  readonly value: string;
}

// What GetSSHConfig hands back for one instance: the SSH gateway endpoint,
// the username to dial it with, a short-lived private key, and the
// gateway's host keys in OpenSSH format ("<type> <base64 key>").
export interface SshConfig {
  readonly username: string;
  readonly endpoint: string;
  readonly privateKey: Uint8Array;
  readonly hostKeys: ReadonlyArray<string>;
}

// GetSSHConfig's Connect-JSON answer: strings and a non-empty host-key
// list (each entry base64 as it arrives).
const SshConfigBody = Schema.Struct({
  username: Schema.String,
  endpoint: Schema.String,
  sshPrivateKey: Schema.String,
  sshHostKeys: Schema.NonEmptyArray(Schema.String),
});

// A Connect error body; both fields may be absent on a bare HTTP error.
const ConnectErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

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
  readonly sshConfig: (
    region: string,
    instanceId: string,
  ) => Effect.Effect<SshConfig, ApiError | ApiLoginError>;
  readonly ensureImageExpiry: (
    image: string,
    hours: number,
  ) => Effect.Effect<void, ApiError | ApiLoginError>;
  readonly checkToken: (
    token: Redacted.Redacted<string>,
    region: Option.Option<string>,
  ) => Effect.Effect<
    ProviderAccount,
    TokenRejectedError | TokenPermissionError | ProviderUnavailableError
  >;
  readonly makeToken: (
    tenant: Redacted.Redacted<string>,
    request: TokenRequest,
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    | TokenDeniedError
    | LoginExpiredError
    | ProviderUnavailableError
    | ProviderError
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
    service = "ComputeService",
    need?: string,
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
        call: `${service}.${call}`,
        ...(need === undefined ? {} : { need }),
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
        id: formatSandboxId({
          provider: "ns",
          region: host.region,
          name: host.instanceId,
        }),
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
      reason: `${service}.${call} failed: ${cause.rawMessage}`,
    });
  };

// The same mapping as fromConnect for a call made over raw Connect JSON:
// `status` the HTTP code, `body` the decoded JSON (an error body holds
// Connect's `code` and `message` strings).
export const httpError = (
  call: string,
  status: number,
  body:
    | {
        readonly code?: string | undefined;
        readonly message?: string | undefined;
      }
    | undefined,
  host?: { readonly region: string; readonly instanceId: string },
): ApiError => {
  const code = body?.code;
  const message = body?.message ?? `HTTP ${status}`;
  if (code === "unauthenticated") {
    return new TokenRejectedError({ provider: "namespace" });
  }
  if (code === "permission_denied") {
    return new TokenPermissionError({
      provider: "namespace",
      call: `ComputeService.${call}`,
    });
  }
  if (code === "resource_exhausted") {
    const found = capacityClause.exec(message);
    return new ProviderLimitError({
      provider: "namespace",
      limit: found === null ? message : found[0],
    });
  }
  if (code === "not_found" && host !== undefined) {
    return new SandboxGoneError({
      id: formatSandboxId({
        provider: "ns",
        region: host.region,
        name: host.instanceId,
      }),
    });
  }
  if (code === "unavailable" || code === "deadline_exceeded" || status >= 500) {
    return unreachable();
  }
  return new ProviderError({
    provider: "namespace",
    reason: `ComputeService.${call} failed: ${message}`,
  });
};

// The Compute API base URL for a region; `{region}` in
// PROOFBOX_NAMESPACE_COMPUTE_URL is replaced by the region.
const computeUrlTemplate = Config.string("PROOFBOX_NAMESPACE_COMPUTE_URL").pipe(
  Config.withDefault("https://{region}.compute.namespaceapis.com"),
);

// The Registry is global, so its base URL takes no {region}.
const registryUrlTemplate = Config.string(
  "PROOFBOX_NAMESPACE_REGISTRY_URL",
).pipe(Config.withDefault("https://global.namespaceapis.com"));

// The IAM API base URL for the token calls; it is a global endpoint,
// not the private sign-in host PROOFBOX_NAMESPACE_IAM_URL names.
const tokenUrl = Config.string("PROOFBOX_NAMESPACE_TOKEN_URL").pipe(
  Config.withDefault("https://iam.namespaceapis.com"),
);

// The only rights a robot token gets: what `create`, `exec`, `list`,
// `delete`, and the Snapshot push need. The push itself runs on the
// Sandbox host with its own registry login.
const ROBOT_GRANTS = [
  {
    resourceType: "instance",
    resourceId: "*",
    actions: ["create", "get", "list", "wait", "refresh", "destroy", "ssh"],
  },
  {
    resourceType: "containerregistry/image",
    resourceId: "*",
    actions: ["get", "update"],
  },
];

export const makeNamespaceApi = (deps: {
  readonly login: ProviderLogin;
  readonly computeUrl?: Config.Config<string>;
  readonly registryUrl?: Config.Config<string>;
}): NamespaceApi => {
  const template = deps.computeUrl ?? computeUrlTemplate;
  const registryTemplate = deps.registryUrl ?? registryUrlTemplate;

  const clientFor = (region: string, token: Redacted.Redacted<string>) =>
    template.pipe(
      Effect.map((url) =>
        createComputeClient({
          transport: createRegionTransport(region, {
            tokenSource: fromBearerToken(Redacted.value(token)),
            baseUrl: url.replaceAll("{region}", region),
          }),
        }),
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

  const registryFor = (token: Redacted.Redacted<string>) =>
    registryTemplate.pipe(
      Effect.map((baseUrl) =>
        createRegistryClient({
          tokenSource: fromBearerToken(Redacted.value(token)),
          transport: createGlobalTransport({
            tokenSource: fromBearerToken(Redacted.value(token)),
            baseUrl,
          }),
        }),
      ),
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    );

  const loggedRegistry = () =>
    Effect.flatMap(deps.login, (hand) => registryFor(hand.token));

  const list = Effect.fn("NamespaceApi.list")(function* (
    region: string,
    labels: ReadonlyArray<LabelEntry>,
  ) {
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
          region:
            instance.hwDeployment?.geoContinent === ""
              ? undefined
              : instance.hwDeployment?.geoContinent,
          createdAt:
            instance.createdAt === undefined
              ? undefined
              : timestampDate(instance.createdAt),
          starting:
            instance.status === InstanceMetadata_Status.PENDING ||
            instance.status === InstanceMetadata_Status.CREATING,
        });
      }
      if (page.paginationCursor.length === 0) {
        return found;
      }
      cursor = page.paginationCursor;
    }
  });

  // A claims-bearing token gives its tenant and expiry; an opaque one
  // (real revocable tokens are `nsrt_`) is still checked with the one
  // ListInstances call, and account and expiry stay unknown.
  const checkToken = Effect.fn("NamespaceApi.checkToken")(function* (
    token: Redacted.Redacted<string>,
    region: Option.Option<string>,
  ) {
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
    const claims = extractClaims(Redacted.value(token));
    const tenantId = claims?.tenant_id;
    const exp = claims?.exp;
    return typeof tenantId === "string" && typeof exp === "number"
      ? { account: tenantId, expiresAt: new Date(exp * 1000) }
      : ({} satisfies ProviderAccount);
  });

  const create = Effect.fn("NamespaceApi.create")(function* (
    region: string,
    req: CreateReq,
  ) {
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

  const wait = Effect.fn("NamespaceApi.wait")(function* (
    region: string,
    instanceId: string,
  ) {
    const client = yield* loggedClient(region);
    yield* Effect.tryPromise({
      try: () => client.compute.waitInstanceSync({ instanceId }),
      catch: fromConnect("WaitInstanceSync", { region, instanceId }),
    });
  });

  const destroy = Effect.fn("NamespaceApi.destroy")(function* (
    region: string,
    instanceId: string,
  ) {
    const client = yield* loggedClient(region);
    yield* Effect.tryPromise({
      try: () => client.compute.destroyInstance({ instanceId }),
      catch: fromConnect("DestroyInstance", { region, instanceId }),
    });
  });

  const extend = Effect.fn("NamespaceApi.extend")(function* (
    region: string,
    instanceId: string,
    seconds: number,
  ) {
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

  // GetSSHConfig answers an `sshHostKeys` field the SDK's proto does not
  // model yet, so this one call goes over Connect JSON itself: a POST to
  // `/<service>/<method>` with a JSON body, errors in Connect's shape.
  const sshConfig = Effect.fn("NamespaceApi.sshConfig")(function* (
    region: string,
    instanceId: string,
  ) {
    const hand = yield* deps.login;
    const base = (yield* template.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    )).replaceAll("{region}", region);
    const response = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(
          `${base}/namespace.cloud.compute.v1beta.ComputeService/GetSSHConfig`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${Redacted.value(hand.token)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ instanceId }),
          },
        );
        const body: unknown = await res.json().catch(() => undefined);
        return { status: res.status, body };
      },
      catch: () => unreachable(),
    });
    const decoded = yield* Schema.decodeUnknown(SshConfigBody)(
      response.body,
    ).pipe(Effect.option);
    if (response.status !== 200) {
      const errorBody = yield* Schema.decodeUnknown(ConnectErrorBody)(
        response.body,
      ).pipe(
        Effect.option,
        Effect.map((body) => Option.getOrUndefined(body)),
      );
      return yield* httpError("GetSSHConfig", response.status, errorBody, {
        region,
        instanceId,
      });
    }
    if (Option.isNone(decoded)) {
      return yield* new ProviderError({
        provider: "namespace",
        reason: "ComputeService.GetSSHConfig gave an incomplete answer",
      });
    }
    const body = decoded.value;
    return {
      username: body.username,
      endpoint: body.endpoint,
      privateKey: new Uint8Array(Buffer.from(body.sshPrivateKey, "base64")),
      hostKeys: body.sshHostKeys.map((key) =>
        Buffer.from(key, "base64").toString("utf8"),
      ),
    } satisfies SshConfig;
  });

  // `<repo>@sha256:<digest>` splits at the first `@` into the Registry's
  // `repository` and `digest`, without host and tenant.
  const ensureImageExpiry = Effect.fn("NamespaceApi.ensureImageExpiry")(
    function* (image: string, hours: number) {
      const client = yield* loggedRegistry();
      const at = image.indexOf("@");
      yield* Effect.tryPromise({
        try: () =>
          client.registry.updateImageLifetime({
            repository: image.slice(0, at),
            digest: image.slice(at + 1),
            ensureMinimumRemaining: {
              seconds: BigInt(hours * 3600),
              nanos: 0,
            },
          }),
        catch: fromConnect(
          "UpdateImageLifetime",
          undefined,
          "ContainerRegistryService",
          "update registry images",
        ),
      });
    },
  );

  // A tenant token mints a revokable robot token over the public IAM
  // endpoint: name, description, expiry, and the grants, the same
  // request Namespace's own CLI sends for a token with no user.
  const makeToken = Effect.fn("NamespaceApi.makeToken")(function* (
    tenant: Redacted.Redacted<string>,
    request: TokenRequest,
  ) {
    const baseUrl = yield* tokenUrl.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    );
    const client = createIAMClient({
      tokenSource: fromBearerToken(Redacted.value(tenant)),
      transport: createGlobalTransport({
        tokenSource: fromBearerToken(Redacted.value(tenant)),
        baseUrl,
      }),
    });
    const made = yield* Effect.tryPromise({
      try: () =>
        client.tokens.createRevokableToken({
          name: request.name,
          description: "Made by proofbox auth token",
          expiresAt: timestampFromDate(request.expiresAt),
          access: { grants: ROBOT_GRANTS },
        }),
      catch: (cause) => {
        if (
          !(cause instanceof ConnectError) ||
          cause.code === Code.Unavailable ||
          cause.code === Code.DeadlineExceeded
        ) {
          return unreachable();
        }
        if (cause.code === Code.PermissionDenied) {
          return new TokenDeniedError({ provider: "namespace" });
        }
        if (cause.code === Code.Unauthenticated) {
          return new LoginExpiredError({ provider: "namespace" });
        }
        return new ProviderError({
          provider: "namespace",
          reason: `TokenService.CreateRevokableToken failed: ${cause.rawMessage}`,
        });
      },
    });
    if (made.bearerToken === "") {
      return yield* new ProviderError({
        provider: "namespace",
        reason: "TokenService.CreateRevokableToken gave no token",
      });
    }
    return Redacted.make(made.bearerToken);
  });

  return {
    create,
    wait,
    destroy,
    extend,
    list,
    sshConfig,
    ensureImageExpiry,
    checkToken,
    makeToken,
  };
};
