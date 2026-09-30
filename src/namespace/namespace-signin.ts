import { extractClaims } from "@namespacelabs/sdk/auth";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { LoginExpiredError, ProviderError } from "../errors.ts";
import { unreachable } from "./namespace-api.ts";

// The one file that names nsl.signin.SigninService, so a change on
// Namespace's side is a one-file fix. Each call is a Connect-JSON POST
// `/<service>/<method>` against the IAM base.
const iamUrl = Config.string("PROOFBOX_NAMESPACE_IAM_URL").pipe(
  Config.withDefault("https://private-api.global.namespaceapis.com"),
);

const SigninErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const decodeErrorBody = (body: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SigninErrorBody)(body));

// Maps a refused sign-in call like httpError maps a refused Compute
// call, naming SigninService.<method>.
const signinError = (method: string, status: number, body: unknown) => {
  const error = decodeErrorBody(body);
  const message = error?.message ?? `HTTP ${status}`;
  if (
    error?.code === "unavailable" ||
    error?.code === "deadline_exceeded" ||
    status >= 500
  ) {
    return unreachable();
  }
  return new ProviderError({
    provider: "namespace",
    reason: `SigninService.${method} failed: ${message}`,
  });
};

// The held CompleteTenantLogin ends early on a Namespace-side
// deadline; the Caller asks again with the same login id when it sees
// one of these endings.
const endedEarly = (answer: {
  readonly status: number;
  readonly body: unknown;
}) =>
  answer.status === 408 ||
  answer.status === 504 ||
  decodeErrorBody(answer.body)?.code === "deadline_exceeded";

// A sign-in call answered oddly (a body that is not the expected JSON)
// is a Provider error, not a bug.
const badAnswer = (method: string) =>
  new ProviderError({
    provider: "namespace",
    reason: `SigninService.${method} gave an incomplete answer`,
  });

const post = (method: string, body: unknown, bearer?: string) =>
  Effect.gen(function* () {
    const base = yield* iamUrl.pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({ provider: "namespace", reason: error.message }),
      ),
    );
    return yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${base}/nsl.signin.SigninService/${method}`, {
          method: "POST",
          headers: {
            ...(bearer === undefined
              ? {}
              : { authorization: `Bearer ${bearer}` }),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const json: unknown = await res.json().catch(() => undefined);
        return { status: res.status, body: json };
      },
      catch: () => unreachable(),
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
export const startLogin = () =>
  Effect.gen(function* () {
    const answer = yield* post(
      "StartLogin",
      Schema.encodeSync(StartLoginBody)({
        supportedKinds: ["tenant"],
        sessionDurationSecs: 2_592_000,
      }),
    );
    if (answer.status !== 200) {
      return yield* signinError("StartLogin", answer.status, answer.body);
    }
    const decoded = yield* Schema.decodeUnknown(StartedLogin)(answer.body).pipe(
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

export const completeLogin = (loginId: string) =>
  Effect.gen(function* () {
    const body = Schema.encodeSync(LoginIdBody)({ loginId });
    let answer = yield* post("CompleteTenantLogin", body);
    while (endedEarly(answer)) {
      answer = yield* post("CompleteTenantLogin", body);
    }
    if (answer.status !== 200) {
      return yield* signinError(
        "CompleteTenantLogin",
        answer.status,
        answer.body,
      );
    }
    const decoded = yield* Schema.decodeUnknown(Schema.Tuple(CompletedLogin))(
      answer.body,
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
  });

// A session trades for a one-hour tenant token: the Bearer every
// Compute call then uses, and one that works in every region.
export const issueTenantToken = (session: string) =>
  Effect.gen(function* () {
    const answer = yield* post(
      "IssueTenantTokenFromSession",
      Schema.encodeSync(TenantTokenBody)({ tokenDurationSecs: 3600 }),
      session,
    );
    const error = decodeErrorBody(answer.body);
    if (answer.status === 401 || error?.code === "unauthenticated") {
      return yield* new LoginExpiredError({ provider: "namespace" });
    }
    if (answer.status !== 200) {
      return yield* signinError(
        "IssueTenantTokenFromSession",
        answer.status,
        answer.body,
      );
    }
    const decoded = yield* Schema.decodeUnknown(IssuedToken)(answer.body).pipe(
      Effect.option,
    );
    if (Option.isNone(decoded)) {
      return yield* badAnswer("IssueTenantTokenFromSession");
    }
    return decoded.value.tenantToken;
  });
