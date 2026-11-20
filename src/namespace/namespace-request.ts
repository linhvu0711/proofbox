import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { Config, Duration, Effect, Option, Schema } from "effect";
import { parseSpan } from "../deadline.ts";
import { ProviderError, ProviderUnavailableError } from "../errors.ts";

const UNREACHABLE =
  "Could not reach Namespace. Check your network and try again.";

export const unreachable = () =>
  new ProviderUnavailableError({
    provider: "namespace",
    reason: UNREACHABLE,
  });

// A request Namespace never answers would hang its command with no end
// (#261), so every request gets this limit unless its call sets one.
const requestTimeout = Config.string("PROOFBOX_NS_REQUEST_TIMEOUT").pipe(
  Config.withDefault("30s"),
);

const requestMillis = Effect.gen(function* () {
  const span = yield* parseSpan(
    "PROOFBOX_NS_REQUEST_TIMEOUT",
    yield* requestTimeout,
    { units: ["ms", "s", "m"], zero: false, example: "30s" },
  );
  return Duration.toMillis(span);
}).pipe(
  Effect.mapError(
    (error) =>
      new ProviderError({ provider: "namespace", reason: error.message }),
  ),
);

// Connect hands each call's own `timeoutMs` to its transport, undefined
// when the call sets none; a limit it hits fails as DeadlineExceeded.
export const limitedTransport = Effect.fn("namespaceRequest.limitedTransport")(
  function* (transport: Transport) {
    const ms = yield* requestMillis;
    return {
      unary: (method, signal, timeoutMs, header, input, contextValues) =>
        transport.unary(
          method,
          signal,
          timeoutMs ?? ms,
          header,
          input,
          contextValues,
        ),
      stream: (method, signal, timeoutMs, header, input, contextValues) =>
        transport.stream(
          method,
          signal,
          timeoutMs ?? ms,
          header,
          input,
          contextValues,
        ),
    } satisfies Transport;
  },
);

// What a refused call means to its caller, by Connect code. A code with
// no meaning reads as unreachable when it is `unavailable` or
// `deadline_exceeded`, else as a Provider error naming the call.
export interface Meanings<E> {
  readonly unauthenticated?: (call: string) => E;
  readonly permissionDenied?: (call: string) => E;
  readonly resourceExhausted?: (message: string) => E;
  readonly notFound?: () => E;
  readonly deadlineExceeded?: () => E;
}

// `call` is the full `Service.Method`, as `SigninService.StartLogin`. A
// cause that is not a ConnectError is a request that got no answer.
export const namespaceError =
  <E = never>(call: string, meanings: Meanings<E> = {}) =>
  (cause: unknown): E | ProviderError | ProviderUnavailableError => {
    if (!(cause instanceof ConnectError)) {
      return unreachable();
    }
    if (
      cause.code === Code.Unauthenticated &&
      meanings.unauthenticated !== undefined
    ) {
      return meanings.unauthenticated(call);
    }
    if (
      cause.code === Code.PermissionDenied &&
      meanings.permissionDenied !== undefined
    ) {
      return meanings.permissionDenied(call);
    }
    if (
      cause.code === Code.ResourceExhausted &&
      meanings.resourceExhausted !== undefined
    ) {
      return meanings.resourceExhausted(cause.rawMessage);
    }
    if (cause.code === Code.NotFound && meanings.notFound !== undefined) {
      return meanings.notFound();
    }
    if (
      cause.code === Code.DeadlineExceeded &&
      meanings.deadlineExceeded !== undefined
    ) {
      return meanings.deadlineExceeded();
    }
    if (
      cause.code === Code.Unavailable ||
      cause.code === Code.DeadlineExceeded
    ) {
      return unreachable();
    }
    return new ProviderError({
      provider: "namespace",
      reason: `${call} failed: ${cause.rawMessage}`,
    });
  };

// A Connect error body; both fields may be absent on a bare HTTP error.
const ConnectErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

// Connect's own string-to-code helpers are marked private, so the codes
// the map reads are named here.
const CODES = new Map<string, Code>([
  ["unauthenticated", Code.Unauthenticated],
  ["permission_denied", Code.PermissionDenied],
  ["resource_exhausted", Code.ResourceExhausted],
  ["not_found", Code.NotFound],
  ["unavailable", Code.Unavailable],
  ["deadline_exceeded", Code.DeadlineExceeded],
]);

// An answer with no Connect code: 401 is a refused login, 408 and 504 a
// Namespace-side deadline, any other 5xx an outage.
const codeOfStatus = (status: number) => {
  if (status === 401) {
    return Code.Unauthenticated;
  }
  if (status === 408 || status === 504) {
    return Code.DeadlineExceeded;
  }
  return status >= 500 ? Code.Unavailable : Code.Unknown;
};

const refusal = (status: number, body: unknown) => {
  const error = Option.getOrUndefined(
    Schema.decodeUnknownOption(ConnectErrorBody)(body),
  );
  const code =
    (error?.code === undefined ? undefined : CODES.get(error.code)) ??
    codeOfStatus(status);
  return new ConnectError(error?.message ?? `HTTP ${status}`, code);
};

// A Connect-JSON call: a POST to `<base>/<service>/<method>` with a JSON
// body, its error in Connect's shape. It gives the 200 answer's body, or
// `undefined` when that body is not JSON. `limited: false` is for the one
// call that waits on purpose.
export const postJson = Effect.fn("namespaceRequest.postJson")(function* <
  E = never,
>(request: {
  readonly base: string;
  readonly service: string;
  readonly method: string;
  readonly body: unknown;
  readonly meanings?: Meanings<E>;
  readonly bearer?: string;
  readonly limited?: boolean;
}) {
  const call = `${request.service.slice(request.service.lastIndexOf(".") + 1)}.${request.method}`;
  const signal =
    request.limited === false
      ? undefined
      : AbortSignal.timeout(yield* requestMillis);
  return yield* Effect.tryPromise({
    try: async () => {
      const res = await fetch(
        `${request.base}/${request.service}/${request.method}`,
        {
          method: "POST",
          headers: {
            ...(request.bearer === undefined
              ? {}
              : { authorization: `Bearer ${request.bearer}` }),
            "content-type": "application/json",
          },
          body: JSON.stringify(request.body),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const body: unknown = await res.json().catch(() => undefined);
      if (res.status !== 200) {
        throw refusal(res.status, body);
      }
      return body;
    },
    catch: namespaceError(call, request.meanings),
  });
});
