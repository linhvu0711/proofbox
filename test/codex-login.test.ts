import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vitest";
import { makeCodexLogin } from "../src/codex-login.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";

afterEach(cleanupEnvs);

const fixture = (script: string) => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-codex-renew-"));
  trackTempDir(home);
  const program = join(home, "codex");
  writeFileSync(program, `#!/bin/sh\nset -eu\n${script}\n`, { mode: 0o755 });
  writeFileSync(
    join(home, "auth.json"),
    '{"auth_mode":"chatgpt","last_refresh":"2026-09-01T00:00:00Z"}',
    { mode: 0o600 },
  );
  return { home, tool: makeCodexLogin(program) };
};

it.effect("codex renew asks codex app-server to renew the login", () =>
  Effect.gen(function* () {
    const { home, tool } = fixture(`echo "$*" >> "$CODEX_HOME/log"
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{"id":1,"result":{}}';;
    *'"account/read"'*)
      printf '{"auth_mode":"chatgpt","last_refresh":"2026-10-05T00:00:00Z"}' > "$CODEX_HOME/auth.json"
      echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
      exit 0;;
  esac
done`);
    yield* tool.renew(home).pipe(Effect.provide(NodeContext.layer));
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(
      '{"auth_mode":"chatgpt","last_refresh":"2026-10-05T00:00:00Z"}',
    );
    expect(readFileSync(join(home, "log"), "utf8")).toBe(
      '-c cli_auth_credentials_store="file" app-server\n',
    );
  }),
);

it.effect(
  "codex renew fails when codex app-server ends before it answers",
  () =>
    Effect.gen(function* () {
      const { home, tool } = fixture("exit 0");
      const error = yield* tool
        .renew(home)
        .pipe(Effect.flip, Effect.provide(NodeContext.layer));
      expect({ tag: error._tag, reason: error.reason }).toEqual({
        tag: "HarnessLoginError",
        reason: "codex app-server ended before it answered",
      });
    }),
);
