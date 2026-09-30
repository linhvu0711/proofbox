import { readFile } from "node:fs/promises";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Schedule } from "effect";
import { SandboxGoneError } from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { loginFor } from "../login/provider-login.ts";
import { makeNamespaceApi } from "./namespace-api.ts";
import { splitHostName } from "./regions.ts";

const id = process.argv[2];
const seconds = Number(process.argv[3]);

(id === undefined || !Number.isFinite(seconds) || seconds <= 0
  ? Effect.void
  : Effect.gen(function* () {
      const api = makeNamespaceApi({ login: loginFor("namespace") });
      const capFile = (yield* keeperPaths({ provider: "ns", name: id }))
        .maxLife;
      const { region, instanceId } = splitHostName(id);
      // The push is fire-and-forget from the caller's side: retry until the
      // host accepts the Deadline or its own Deadline passes. Each attempt
      // reads the Max-life cap again and recomputes the remaining window so
      // a delayed retry can never push the host past the Sandbox's Max life.
      // A missing or unreadable cap means the create did not finish (or the
      // Sandbox is being deleted): skip the push rather than run uncapped.
      yield* Effect.gen(function* () {
        const cap = yield* Effect.tryPromise(() =>
          readFile(capFile, "utf8").then((text) => Number(text.trim())),
        ).pipe(Effect.orElseSucceed(() => Number.NaN));
        if (!Number.isFinite(cap)) return;
        const left = Math.floor(cap - Date.now() / 1000);
        if (left <= 0) return;
        yield* api.extend(region, instanceId, Math.min(seconds, left));
      }).pipe(
        Effect.retry(
          Schedule.spaced(Duration.seconds(15)).pipe(
            Schedule.upTo(Duration.seconds(seconds)),
            Schedule.whileInput(
              (error) => !(error instanceof SandboxGoneError),
            ),
          ),
        ),
        Effect.ignore,
      );
    })
).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
