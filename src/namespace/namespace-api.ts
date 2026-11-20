import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
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
import {
  limitedTransport,
  type Meanings,
  namespaceError,
  postJson,
  unreachable,
} from "./namespace-request.ts";
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

interface LabelEntry {
  readonly name: string;
  readonly value: string;
}

// What GetSSHConfig hands back for one instance: the SSH gateway endpoint,
// the username to dial it with, a short-lived private key, and the
// gateway's host keys in OpenSSH format ("<type> <base64 key>").
interface SshConfig {
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

// A refused create names the capacity it wanted; pull the clause that
// ends at the first `)` so the size is included.
const capacityClause = /ran out of capacity:[^)]*\)/;

// What a refused Compute or registry call means: `host` is the instance a
// `not_found` is about, `need` the right a permission error names.
const apiMeanings = (options?: {
  readonly host?: { readonly region: string; readonly instanceId: string };
  readonly need?: string;
}): Meanings<ApiError> => {
  const host = options?.host;
  return {
    unauthenticated: () => new TokenRejectedError({ provider: "namespace" }),
    permissionDenied: (call) =>
      new TokenPermissionError({
        provider: "namespace",
        call,
        ...(options?.need === undefined ? {} : { need: options.need }),
      }),
    resourceExhausted: (message) => {
      const found = capacityClause.exec(message);
      return new ProviderLimitError({
        provider: "namespace",
        limit: found === null ? message : found[0],
      });
    },
    ...(host === undefined
      ? {}
      : {
          notFound: () =>
            new SandboxGoneError({
              id: formatSandboxId({
                provider: "ns",
                region: host.region,
                name: host.instanceId,
              }),
            }),
        }),
  };
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
}): NamespaceApi => {
  // `limited: false` makes a client with no request limit, for the one
  // call that waits on purpose.
  const clientFor = (
    region: string,
    token: Redacted.Redacted<string>,
    limited = true,
  ) =>
    Effect.gen(function* () {
      const url = yield* computeUrlTemplate.pipe(
        Effect.mapError(
          (error) =>
            new ProviderError({ provider: "namespace", reason: error.message }),
        ),
      );
      const transport = createRegionTransport(region, {
        tokenSource: fromBearerToken(Redacted.value(token)),
        baseUrl: url.replaceAll("{region}", region),
      });
      return createComputeClient({
        transport: limited ? yield* limitedTransport(transport) : transport,
      });
    });

  // The token comes from the login in hand, so every call sees the
  // freshest env or saved login.
  const loggedClient = (region: string, limited = true) =>
    Effect.flatMap(deps.login, (hand) =>
      clientFor(region, hand.token, limited),
    );

  const registryFor = (token: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const baseUrl = yield* registryUrlTemplate.pipe(
        Effect.mapError(
          (error) =>
            new ProviderError({ provider: "namespace", reason: error.message }),
        ),
      );
      return createRegistryClient({
        tokenSource: fromBearerToken(Redacted.value(token)),
        transport: yield* limitedTransport(
          createGlobalTransport({
            tokenSource: fromBearerToken(Redacted.value(token)),
            baseUrl,
          }),
        ),
      });
    });

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
        catch: namespaceError("ComputeService.ListInstances", apiMeanings()),
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
      catch: namespaceError("ComputeService.ListInstances", apiMeanings()),
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
      catch: namespaceError("ComputeService.CreateInstance", apiMeanings()),
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
    // The create timeout bounds this wait, so it takes no request limit.
    const client = yield* loggedClient(region, false);
    yield* Effect.tryPromise({
      try: () => client.compute.waitInstanceSync({ instanceId }),
      catch: namespaceError(
        "ComputeService.WaitInstanceSync",
        apiMeanings({ host: { region, instanceId } }),
      ),
    });
  });

  const destroy = Effect.fn("NamespaceApi.destroy")(function* (
    region: string,
    instanceId: string,
  ) {
    const client = yield* loggedClient(region);
    yield* Effect.tryPromise({
      try: () => client.compute.destroyInstance({ instanceId }),
      catch: namespaceError(
        "ComputeService.DestroyInstance",
        apiMeanings({ host: { region, instanceId } }),
      ),
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
      catch: namespaceError(
        "ComputeService.ExtendInstance",
        apiMeanings({ host: { region, instanceId } }),
      ),
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
    const base = (yield* computeUrlTemplate.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    )).replaceAll("{region}", region);
    const answer = yield* postJson({
      base,
      service: "namespace.cloud.compute.v1beta.ComputeService",
      method: "GetSSHConfig",
      body: { instanceId },
      bearer: Redacted.value(hand.token),
      meanings: apiMeanings({ host: { region, instanceId } }),
    });
    const decoded = yield* Schema.decodeUnknown(SshConfigBody)(answer).pipe(
      Effect.option,
    );
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
        catch: namespaceError(
          "ContainerRegistryService.UpdateImageLifetime",
          apiMeanings({ need: "update registry images" }),
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
      transport: yield* limitedTransport(
        createGlobalTransport({
          tokenSource: fromBearerToken(Redacted.value(tenant)),
          baseUrl,
        }),
      ),
    });
    const made = yield* Effect.tryPromise({
      try: () =>
        client.tokens.createRevokableToken({
          name: request.name,
          description: "Made by proofbox auth token",
          expiresAt: timestampFromDate(request.expiresAt),
          access: { grants: ROBOT_GRANTS },
        }),
      catch: namespaceError<TokenDeniedError | LoginExpiredError>(
        "TokenService.CreateRevokableToken",
        {
          permissionDenied: () =>
            new TokenDeniedError({ provider: "namespace" }),
          unauthenticated: () =>
            new LoginExpiredError({ provider: "namespace" }),
        },
      ),
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
