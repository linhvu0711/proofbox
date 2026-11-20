import { extractClaims } from "@namespacelabs/sdk/auth";
import { Config, Data, Effect, Option, Redacted, Schema } from "effect";
import {
  LoginExpiredError,
  ProviderError,
  type ProviderUnavailableError,
} from "../errors.ts";
import { type Meanings, postJson } from "./namespace-request.ts";

// The one file that names nsl.signin.SigninService, so a change on
// Namespace's side is a one-file fix. Each call is a Connect-JSON POST
// `/<service>/<method>` against the IAM base.
const iamUrl = Config.string("PROOFBOX_NAMESPACE_IAM_URL").pipe(
  Config.withDefault("https://private-api.global.namespaceapis.com"),
);

// The held CompleteTenantLogin ends early on a Namespace-side
// deadline; the Caller asks again with the same login id when it sees
// one.
class EndedEarlyError extends Data.TaggedError("EndedEarlyError") {}

// A sign-in call answered oddly (a body that is not the expected JSON)
// is a Provider error, not a bug.
const badAnswer = (method: string) =>
  new ProviderError({
    provider: "namespace",
    reason: `SigninService.${method} gave an incomplete answer`,
  });

const signinPost = Effect.fn("namespaceSignin.post")(function* <E = never>(
  method: string,
  body: unknown,
  options?: {
    readonly meanings?: Meanings<E>;
    readonly bearer?: string;
    readonly limited?: boolean;
  },
) {
  const base = yield* iamUrl.pipe(
    Effect.mapError(
      (error) =>
        new ProviderError({ provider: "namespace", reason: error.message }),
    ),
  );
  return yield* postJson({
    base,
    service: "nsl.signin.SigninService",
    method,
    body,
    ...options,
  });
});

// The SigninService wire names are snake_case; the Schema fields keep
// camelCase and name their wire key.
const StartLoginBody = Schema.Struct({
  supportedKinds: Schema.propertySignature(Schema.Array(Schema.String)).pipe(
    Schema.fromKey("supported_kinds"),
  ),
  sessionDurationSecs: Schema.propertySignature(Schema.NonNegativeInt).pipe(
    Schema.fromKey("session_duration_secs"),
  ),
});

const LoginIdBody = Schema.Struct({
  loginId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("login_id"),
  ),
});

const TenantTokenBody = Schema.Struct({
  tokenDurationSecs: Schema.propertySignature(Schema.NonNegativeInt).pipe(
    Schema.fromKey("token_duration_secs"),
  ),
});

const IssuedToken = Schema.Struct({
  tenantToken: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("tenant_token"),
  ),
});

const StartedLogin = Schema.Struct({
  loginId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("login_id"),
  ),
  loginUrl: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("login_url"),
  ),
  kind: Schema.String,
});

const CompletedLogin = Schema.Struct({
  tenantName: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("tenant_name"),
  ),
  sessionToken: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("session_token"),
  ),
});

// A 30-day login: opens the wait for a click on the login page and names
// the page's URL.
export const startLogin = Effect.fn("namespaceSignin.startLogin")(function* () {
  const answer = yield* signinPost(
    "StartLogin",
    Schema.encodeSync(StartLoginBody)({
      supportedKinds: ["tenant"],
      sessionDurationSecs: 2_592_000,
    }),
  );
  const decoded = yield* Schema.decodeUnknown(StartedLogin)(answer).pipe(
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    return yield* badAnswer("StartLogin");
  }
  if (decoded.value.kind !== "tenant") {
    return yield* new ProviderError({
      provider: "namespace",
      reason: `SigninService.StartLogin made a ${decoded.value.kind} login`,
    });
  }
  return { loginId: decoded.value.loginId, url: decoded.value.loginUrl };
});

export const completeLogin = Effect.fn("namespaceSignin.completeLogin")(
  function* (loginId: string) {
    const answer = yield* signinPost(
      "CompleteTenantLogin",
      Schema.encodeSync(LoginIdBody)({ loginId }),
      {
        // The login wait bounds this call; it waits while the Caller
        // logs in.
        limited: false,
        meanings: { deadlineExceeded: () => new EndedEarlyError() },
      },
    ).pipe(
      Effect.retry({
        until: (error): error is ProviderError | ProviderUnavailableError =>
          !(error instanceof EndedEarlyError),
      }),
    );
    const decoded = yield* Schema.decodeUnknown(Schema.Tuple(CompletedLogin))(
      answer,
    ).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      return yield* badAnswer("CompleteTenantLogin");
    }
    const row = decoded.value[0];
    const exp = extractClaims(row.sessionToken)?.exp;
    if (typeof exp !== "number") {
      return yield* badAnswer("CompleteTenantLogin");
    }
    return {
      session: Redacted.make(row.sessionToken),
      account: row.tenantName,
      expiresAt: new Date(exp * 1000),
    };
  },
);

// A session trades for a one-hour tenant token: the Bearer every
// Compute call then uses, and one that works in every region.
export const issueTenantToken = Effect.fn("namespaceSignin.issueTenantToken")(
  function* (session: string) {
    const answer = yield* signinPost(
      "IssueTenantTokenFromSession",
      Schema.encodeSync(TenantTokenBody)({ tokenDurationSecs: 3600 }),
      {
        bearer: session,
        meanings: {
          unauthenticated: () =>
            new LoginExpiredError({ provider: "namespace" }),
        },
      },
    );
    const decoded = yield* Schema.decodeUnknown(IssuedToken)(answer).pipe(
      Effect.option,
    );
    if (Option.isNone(decoded)) {
      return yield* badAnswer("IssueTenantTokenFromSession");
    }
    return decoded.value.tenantToken;
  },
);
