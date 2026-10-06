import { createServer } from "node:http";

export interface FakeGithubCall {
  readonly path: string;
  readonly accept: string | undefined;
}

export interface FakeGithubAnswer {
  readonly status: number;
  readonly body: string;
}

export interface FakeGithub {
  readonly url: string;
  readonly calls: ReadonlyArray<FakeGithubCall>;
  readonly close: () => Promise<void>;
}

// A node:http server standing in for the GitHub REST API: it records the
// path and Accept header of every call and answers what `answer` says.
export const startFakeGithub = (
  answer: (call: FakeGithubCall) => FakeGithubAnswer,
): Promise<FakeGithub> =>
  new Promise((resolve) => {
    const calls: FakeGithubCall[] = [];
    const server = createServer((req, res) => {
      const call: FakeGithubCall = {
        path: req.url ?? "",
        accept: req.headers.accept,
      };
      calls.push(call);
      req.resume();
      const reply = answer(call);
      res.writeHead(reply.status, { "content-type": "text/plain" });
      res.end(reply.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
