import { createServer } from "node:http";

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
]);

const PATH =
  /^\/([^/]+)\/namespace\.cloud\.compute\.v1beta\.ComputeService\/([^/]+)$/;

// A node:http server standing in for the Compute API: it records every
// call and answers what `answer` says. "hang" never answers, standing in
// for a call that never finishes.
export const startFakeNamespace = (
  answer: (call: FakeNamespaceCall) => FakeNamespaceAnswer,
  port = 0,
): Promise<FakeNamespace> =>
  new Promise((resolve) => {
    const calls: FakeNamespaceCall[] = [];
    const server = createServer((req, res) => {
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
        const reply = answer(call);
        if (reply === "hang") {
          return;
        }
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
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${bound}/{region}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
