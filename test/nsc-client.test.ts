import { readFileSync } from "node:fs";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { makeNscClient } from "../src/namespace/nsc-client.ts";
import { cleanupEnvs } from "./support/cli.ts";
import { makeFakeNsc } from "./support/fake-nsc.ts";

describe("nsc client", () => {
  afterEach(cleanupEnvs);

  it.effect(
    "ensureImageExpiry runs nsc registry update-image-expiration --ensure-minimum",
    () => {
      const fake = makeFakeNsc("exit 0");
      return Effect.gen(function* () {
        // Given: an nsc that logs its argv and exits 0
        const executor = yield* CommandExecutor.CommandExecutor;
        // When
        yield* makeNscClient(executor).ensureImageExpiry(
          "proofbox-snapshot-linux@sha256:ab12",
          336,
        );
        // Then
        expect(readFileSync(fake.log, "utf8")).toBe(
          "registry update-image-expiration proofbox-snapshot-linux@sha256:ab12 --ensure-minimum 336h\n",
        );
      }).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_NSC", fake.path]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );
});
