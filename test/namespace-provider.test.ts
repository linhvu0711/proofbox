import { it } from "@effect/vitest";
import { Effect, Ref, TestClock } from "effect";
import { describe, expect } from "vitest";
import { makeNamespaceProvider } from "../src/namespace/namespace-provider.ts";
import type { NscClient } from "../src/namespace/nsc-client.ts";
import type { Link } from "../src/namespace/ssh-link.ts";

const fakeNsc = (calls: Ref.Ref<ReadonlyArray<string>>): NscClient => ({
  checkLogin: Ref.update(calls, (all) => [...all, "checkLogin"]),
  create: () =>
    Ref.update(calls, (all) => [...all, "create"]).pipe(
      Effect.as("abc123def4567"),
    ),
  destroy: (id) => Ref.update(calls, (all) => [...all, `destroy ${id}`]),
  extend: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  portForward: () => Effect.die("unused"),
});

describe("Namespace Provider", () => {
  it.effect(
    "extend writes the Deadline and starts nsc extend for the seconds left",
    () =>
      Effect.gen(function* () {
        // Given
        const commands = yield* Ref.make<ReadonlyArray<string>>([]);
        const link: Link = {
          ssh: [],
          run: (commandLine) =>
            Ref.update(commands, (all) => [...all, commandLine]).pipe(
              Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
            ),
        };
        const spawned = yield* Ref.make<
          ReadonlyArray<readonly [string, string, ReadonlyArray<string>]>
        >([]);
        const provider = makeNamespaceProvider({
          nsc: fakeNsc(yield* Ref.make<ReadonlyArray<string>>([])),
          openLink: () => Effect.succeed(link),
          dockerFor: () => {
            throw new Error("unused");
          },
          spawnDetached: (provider, rel, args) =>
            Ref.update(spawned, (all) => [
              ...all,
              [provider, rel, args] as const,
            ]),
        });
        yield* TestClock.setTime(new Date("1970-01-01T00:10:00Z").getTime());
        // When
        yield* provider.extend(
          "abc123def4567",
          new Date("1970-01-01T00:25:00Z"),
        );
        // Then
        const seen = yield* Ref.get(commands);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("docker exec -u root proofbox-abc123");
        expect(seen[0]).toContain("900");
        expect(yield* Ref.get(spawned)).toEqual([
          ["namespace", "namespace/extend-main", ["abc123def4567", "900"]],
        ]);
      }),
  );
});
