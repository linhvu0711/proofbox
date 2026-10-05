import { Command } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Deferred, Effect, Option, Schema, Stream } from "effect";
import { CliOutput } from "./cli-output.ts";
import { HarnessLoginError, platformReason } from "./errors.ts";
import type { FileLoginTool } from "./harness.ts";
import { lastRefreshOf } from "./login/logins-file.ts";

const INSTALL =
  "codex is not installed on this machine; install it with: curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const REQUESTS = [
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"proofbox","version":"0"}}}',
  '{"method":"initialized"}',
  '{"id":2,"method":"account/read","params":{"refreshToken":true}}',
]
  .join("\n")
  .concat("\n");

const AccountResponse = Schema.parseJson(
  Schema.Struct({
    id: Schema.Literal(2),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);

export const makeCodexLogin = (program: string): FileLoginTool => {
  const bad = (reason: string) =>
    new HarnessLoginError({ harness: "codex", reason, nothing: "saved" });
  const failed = (error: PlatformError) =>
    bad(
      error._tag === "SystemError" && error.reason === "NotFound"
        ? INSTALL
        : platformReason(error),
    );
  const command = (home: string, ...args: string[]) =>
    Command.make(
      program,
      "-c",
      'cli_auth_credentials_store="file"',
      ...args,
    ).pipe(Command.env({ CODEX_HOME: home }));
  return {
    login: Effect.fn("codexLogin.login")(
      function* (home: string) {
        const output = yield* CliOutput;
        const process = yield* Command.start(
          command(home, "login", "--device-auth"),
        );
        const lines = Stream.merge(
          process.stdout.pipe(Stream.decodeText(), Stream.splitLines),
          process.stderr.pipe(Stream.decodeText(), Stream.splitLines),
        );
        yield* Stream.runForEach(lines, (line) => {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI colors from Codex output.
          const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
          return plain.trim() === "" ? Effect.void : output.err(`${plain}\n`);
        });
        const code = yield* process.exitCode;
        if (code !== 0)
          return yield* bad(`codex login failed (exit code ${code})`);
      },
      Effect.scoped,
      Effect.mapError((error) =>
        error._tag === "HarnessLoginError" ? error : failed(error),
      ),
    ),
    renew: Effect.fn("codexLogin.renew")(
      function* (home: string) {
        const done = yield* Deferred.make<void>();
        const stdin = Stream.concat(
          Stream.make(new TextEncoder().encode(REQUESTS)),
          Stream.fromEffect(Deferred.await(done)).pipe(Stream.drain),
        );
        const process = yield* Command.start(
          command(home, "app-server").pipe(Command.stdin(stdin)),
        );
        let answered = false;
        yield* Effect.all(
          [
            Stream.runForEach(
              process.stdout.pipe(Stream.decodeText(), Stream.splitLines),
              (line) => {
                const decoded =
                  Schema.decodeUnknownOption(AccountResponse)(line);
                if (Option.isNone(decoded)) return Effect.void;
                const response = decoded.value;
                if (response.error !== undefined)
                  return Effect.fail(
                    bad(
                      `codex app-server refused to renew: ${response.error.message}`,
                    ),
                  );
                if (response.result === undefined) return Effect.void;
                answered = true;
                return Deferred.succeed(done, undefined);
              },
            ),
            Stream.runDrain(process.stderr),
          ],
          { concurrency: "unbounded" },
        );
        if (!answered)
          return yield* bad("codex app-server ended before it answered");
        const code = yield* process.exitCode;
        if (code !== 0)
          return yield* bad(`codex app-server failed (exit code ${code})`);
      },
      Effect.scoped,
      Effect.timeoutFail({
        duration: "30 seconds",
        onTimeout: () => bad("codex app-server did not answer in 30s"),
      }),
      Effect.mapError((error) =>
        error._tag === "HarnessLoginError" ? error : failed(error),
      ),
    ),
    renewedAt: lastRefreshOf,
    accountOf: (text) =>
      Schema.decodeUnknownOption(
        Schema.parseJson(
          Schema.Struct({
            tokens: Schema.Struct({
              // biome-ignore lint/style/useNamingConvention: Codex auth.json field.
              account_id: Schema.String,
            }),
          }),
        ),
      )(text).pipe(Option.map((login) => login.tokens.account_id)),
  };
};
