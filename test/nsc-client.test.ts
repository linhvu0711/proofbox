import { readFileSync } from "node:fs";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { CommandExecutor } from "@effect/platform";
import { ConfigProvider, Effect } from "effect";
import { describe, expect } from "vitest";
import { makeNscClient } from "../src/namespace/nsc-client.ts";
import { makeFakeNsc } from "./support/fake-nsc.ts";

describe("nsc client", () => {
  it.effect(
    "ensureImageExpiry asks nsc to keep the image for the hours given",
    () => {
      // Given: a fake nsc that logs argv and exits 0
      const fake = makeFakeNsc("exit 0");
      return Effect.gen(function* () {
        const client = makeNscClient(yield* CommandExecutor.CommandExecutor);
        // When
        yield* client.ensureImageExpiry(
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
