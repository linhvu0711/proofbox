import { createServer } from "node:http";
import { Option, Schema } from "effect";

export interface FakeNamespaceCall {
  readonly region: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

export type FakeNamespaceAnswer =
  | { readonly json: unknown }
  | { readonly error: { readonly code: string; readonly message: string } }
  | "hang";

export interface FakeNamespace {
  readonly url: string;
  readonly calls: ReadonlyArray<FakeNamespaceCall>;
  readonly close: () => Promise<void>;
}

const STATUS = new Map([
  ["unauthenticated", 401],
  ["permission_denied", 403],
  ["not_found", 404],
  ["resource_exhausted", 429],
  ["unavailable", 503],
  ["deadline_exceeded", 504],
]);

// <region>/namespace.cloud.compute.v1beta.ComputeService/<method>, or the
// sign-in service's own /<service>/<method> (the call's region is "").
const PATH =
  /^\/(?:([^/]+)\/namespace\.cloud\.compute\.v1beta\.ComputeService|nsl\.signin\.SigninService)\/([^/]+)$/;

const LOGIN_PAGE = /^\/login\/([^/]+)$/;

// The SigninService wire names are snake_case; JSON built through this
// keeps camelCase keys in the sources.
export const toSnakeKeys = <A>(o: Readonly<Record<string, A>>) =>
  Object.fromEntries(
    Object.entries(o).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );

const LoginIdBody = Schema.Struct({
  loginId: Schema.propertySignature(Schema.String).pipe(
    Schema.fromKey("login_id"),
  ),
});

// The session CompleteTenantLogin hands back for the n-th login and
// the tenant token IssueTenantTokenFromSession makes: JWTs for tenants
// tnt_team1 and tnt_team2, exp 3000-01-01T00:00:00Z.
export const SESSION_1 =
  "st_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVhbTEiLCJleHAiOjMyNTAzNjgwMDAwfQ.sig";
export const SESSION_2 =
  "st_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVhbTIiLCJleHAiOjMyNTAzNjgwMDAwfQ.sig";
export const TENANT_1 =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVhbTEiLCJleHAiOjMyNTAzNjgwMDAwfQ.sig";
export const TENANT_2 =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVhbTIiLCJleHAiOjMyNTAzNjgwMDAwfQ.sig";
// A minted token already past its expiry (exp 1970-01-01T00:01:40Z).
export const EXPIRED_TENANT_1 =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVhbTEiLCJleHAiOjEwMH0.sig";

// The sign-in side of a fake: `answer` takes the calls to
// nsl.signin.SigninService, `workspaceOf` names the workspace a login id
// belongs to so the login page can label its button, and `click` marks a
// login clicked — the POST the login page's button sends.
export interface FakeSignin {
  readonly answer: (
    call: FakeNamespaceCall,
    base: string,
  ) => FakeNamespaceAnswer | Promise<FakeNamespaceAnswer>;
  readonly workspaceOf: (loginId: string) => string | undefined;
  readonly click: (loginId: string) => void;
}

// The login flow `nsc login` uses: StartLogin hands back a login id and
// the page's URL; CompleteTenantLogin stays unanswered until the page's
// button is clicked (a click before the call counts); IssueTenantToken
// trades the session for a tenant token.
export const fakeSignin = (options?: {
  readonly workspace?: (n: number) => string;
  readonly session?: (n: number) => string;
  readonly tenantToken?: string;
}): FakeSignin => {
  const workspaceOf = options?.workspace ?? ((n: number) => `team-${n}`);
  const sessionOf =
    options?.session ?? ((n: number) => (n % 2 === 1 ? SESSION_1 : SESSION_2));
  const tenantToken = options?.tenantToken ?? TENANT_1;
  let started = 0;
  const pending = new Map<
    string,
    { readonly workspace: string; readonly session: string }
  >();
  const clicked = new Set<string>();
  const waiting = new Map<
    string,
    Array<(answer: FakeNamespaceAnswer) => void>
  >();
  const completed = (
    loginId: string,
  ): FakeNamespaceAnswer | Promise<FakeNamespaceAnswer> => {
    const login = pending.get(loginId);
    if (login === undefined) {
      return { error: { code: "not_found", message: "no such login" } };
    }
    if (clicked.has(loginId)) {
      return {
        json: [
          toSnakeKeys({
            tenantName: login.workspace,
            sessionToken: login.session,
          }),
        ],
      };
    }
    return new Promise((resolve) => {
      const held = waiting.get(loginId) ?? [];
      held.push(resolve);
      waiting.set(loginId, held);
    });
  };
  return {
    answer: (call, base) => {
      if (call.method === "StartLogin") {
        started += 1;
        const loginId = `L${started}`;
        pending.set(loginId, {
          workspace: workspaceOf(started),
          session: sessionOf(started),
        });
        return {
          json: toSnakeKeys({
            loginId,
            loginUrl: `${base}/login/${loginId}`,
            kind: "tenant",
          }),
        };
      }
      if (call.method === "CompleteTenantLogin") {
        const body = Option.getOrUndefined(
          Schema.decodeUnknownOption(LoginIdBody)(call.body),
        );
        return completed(body?.loginId ?? "");
      }
      if (call.method === "IssueTenantTokenFromSession") {
        return { json: toSnakeKeys({ tenantToken }) };
      }
      return { json: {} };
    },
    workspaceOf: (loginId) => pending.get(loginId)?.workspace,
    click: (loginId) => {
      clicked.add(loginId);
      const done = completed(loginId);
      if (done instanceof Promise) {
        return;
      }
      for (const resolve of waiting.get(loginId) ?? []) {
        resolve(done);
      }
      waiting.delete(loginId);
    },
  };
};

const send = (
  res: import("node:http").ServerResponse,
  reply: Exclude<FakeNamespaceAnswer, "hang">,
) => {
  if ("error" in reply) {
    res.writeHead(STATUS.get(reply.error.code) ?? 500, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        code: reply.error.code,
        message: reply.error.message,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.json));
};

// A node:http server standing in for the Compute API and, when `signin`
// is given, the sign-in service and the login page: it records every
// call and answers what `answer` says. "hang" never answers, standing in
// for a call that never finishes.
export const startFakeNamespace = (
  answer: (
    call: FakeNamespaceCall,
  ) => FakeNamespaceAnswer | Promise<FakeNamespaceAnswer>,
  port = 0,
  signin?: FakeSignin,
): Promise<FakeNamespace> =>
  new Promise((resolve) => {
    let bound = 0;
    const calls: FakeNamespaceCall[] = [];
    const server = createServer((req, res) => {
      const page = LOGIN_PAGE.exec(req.url ?? "")?.[1];
      if (signin !== undefined && page !== undefined) {
        if (req.method === "POST") {
          req.resume();
          signin.click(page);
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("Logged in. You can close this tab.\n");
          return;
        }
        const workspace = signin.workspaceOf(page) ?? page;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<!doctype html><html><body><h1>Namespace (fake)</h1><form method="post"><button type="submit">Log in to ${workspace}</button></form></body></html>\n`,
        );
        return;
      }
      const match = PATH.exec(req.url ?? "");
      let text = "";
      req.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      req.on("end", () => {
        const call: FakeNamespaceCall = {
          region: match?.[1] ?? "",
          method: match?.[2] ?? "",
          body: JSON.parse(text === "" ? "{}" : text) as unknown,
          authorization: req.headers.authorization,
        };
        calls.push(call);
        void Promise.resolve(
          match !== null && match[1] === undefined && signin !== undefined
            ? signin.answer(call, `http://127.0.0.1:${bound}`)
            : answer(call),
        ).then((reply) => {
          if (reply === "hang") {
            return;
          }
          send(res, reply);
        });
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      bound =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${bound}/{region}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
