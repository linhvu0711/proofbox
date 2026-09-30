import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeNscClient } from "../src/namespace/nsc-client.ts";
import { cleanupEnvs } from "./support/cli.ts";
import { makeFakeNsc } from "./support/fake-nsc.ts";

const TOKEN =
  "nsct_eyJhbGciOiJub25lIn0.eyJ0ZW5hbnRfaWQiOiJ0bnRfdGVzdCIsImV4cCI6MzI1MDM2ODAwMDB9.sig";

const login = (region: Option.Option<string>) =>
  Effect.succeed({ token: Redacted.make(TOKEN), region });

const runtimeDir = () => mkdtempSync(join(tmpdir(), "proofbox-runtime-"));

describe("nsc client", () => {
  afterEach(cleanupEnvs);

  it.effect(
    "portForward runs nsc in the Sandbox's region with the proofbox token file",
    () => {
      // Given: an nsc that logs its argv and token file, answers Listening,
      // then stays up for the scope
      const fake = makeFakeNsc(
        `printf 'Listening on 127.0.0.1:40022\\n'\nsleep 60\n`,
      );
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        const executor = yield* CommandExecutor.CommandExecutor;
        // When: a us Sandbox's port is opened from an eu login
        const forward = yield* makeNscClient(
          executor,
          login(Option.some("eu")),
        ).portForward("us:abc123def4567", 5900);
        // Then: the id's region won, and nsc got the proofbox token file
        const [argv, file] = readFileSync(fake.log, "utf8").split("\n");
        expect(argv).toBe(
          "--region us instance port-forward abc123def4567 --target_port 5900",
        );
        expect(readFileSync(file ?? "", "utf8")).toBe(
          `{"bearer_token":"${TOKEN}"}\n`,
        );
        expect(statSync(file ?? "").mode & 0o777).toBe(0o600);
        expect(forward.port).toBe(40022);
      }).pipe(
        Effect.scoped,
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["PROOFBOX_NSC", fake.path],
              ["PROOFBOX_RUNTIME_DIR", runtime],
            ]),
          ),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );

  it.effect(
    "ensureImageExpiry runs nsc registry update-image-expiration --ensure-minimum",
    () => {
      const fake = makeFakeNsc("exit 0");
      const runtime = runtimeDir();
      return Effect.gen(function* () {
        // Given: an nsc that logs its argv and token file, and exits 0
        const executor = yield* CommandExecutor.CommandExecutor;
        // When
        yield* makeNscClient(executor, login(Option.none())).ensureImageExpiry(
          "proofbox-snapshot-linux@sha256:ab12",
          336,
        );
        // Then
        const [argv, file] = readFileSync(fake.log, "utf8").split("\n");
        expect(argv).toBe(
          "registry update-image-expiration proofbox-snapshot-linux@sha256:ab12 --ensure-minimum 336h",
        );
        expect(readFileSync(file ?? "", "utf8")).toBe(
          `{"bearer_token":"${TOKEN}"}\n`,
        );
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["PROOFBOX_NSC", fake.path],
              ["PROOFBOX_RUNTIME_DIR", runtime],
            ]),
          ),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );
});
