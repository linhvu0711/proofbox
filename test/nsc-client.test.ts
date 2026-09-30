import { mkdtempSync, readFileSync } from "node:fs";
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
