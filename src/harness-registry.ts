import { Config, Duration, Effect, Layer, Option } from "effect";
import { HarnessError } from "./errors.ts";
import { type HarnessEntry, Harnesses } from "./harness.ts";

const importFor = Effect.fn("harnessRegistry.importFor")(
  <A>(harness: string, load: () => Promise<A>) =>
    Effect.tryPromise({
      try: load,
      catch: (cause) => new HarnessError({ harness, reason: String(cause) }),
    }),
);

export const HarnessesLive = Layer.effect(
  Harnesses,
  Effect.gen(function* () {
    const harnesses = new Map<string, HarnessEntry>([
      [
        "claude",
        {
          name: "claude",
          login: {
            envName: "CLAUDE_CODE_OAUTH_TOKEN",
            what: "token",
            placeholder: "<token>",
            howToMake: "Make one with `claude setup-token`",
            lifetime: Option.some(Duration.days(365)),
          },
          profile: {
            home: ".claude",
            parts: ["CLAUDE.md", "skills/", "agents/"],
            leftOut: "settings.json, hooks, plugins, and MCP config",
          },
          // Stand-in replaced by #191 and #193.
          load: Effect.fail(
            new HarnessError({
              harness: "claude",
              reason: "not built yet (#191, #193)",
            }),
          ),
        },
      ],
      [
        "codex",
        {
          name: "codex",
          login: {
            envName: "CODEX_API_KEY",
            what: "API key",
            placeholder: "<key>",
            howToMake: "Make one at https://platform.openai.com/api-keys",
            lifetime: Option.none(),
          },
          profile: {
            home: ".codex",
            parts: ["AGENTS.md", "skills/"],
            leftOut: "config.toml, hooks, plugins, and MCP config",
          },
          // Stand-in replaced by #194.
          load: Effect.fail(
            new HarnessError({
              harness: "codex",
              reason: "not built yet (#194)",
            }),
          ),
        },
      ],
    ]);
    const fakeRoot = yield* Config.option(Config.string("PROOFBOX_FAKE_ROOT"));
    if (Option.isSome(fakeRoot)) {
      const fake = yield* Effect.cached(
        importFor("fake", () => import("./fake/fake-harness.ts")).pipe(
          Effect.map((module) => module.makeFakeHarness()),
        ),
      );
      harnesses.set("fake", {
        name: "fake",
        login: {
          envName: "PROOFBOX_FAKE_HARNESS_TOKEN",
          what: "token",
          placeholder: "<token>",
          howToMake: "Make one with `fake-harness token`",
          lifetime: Option.none(),
        },
        profile: {
          home: ".fake-harness",
          parts: ["AGENTS.md", "skills/"],
          leftOut: "settings",
        },
        load: fake,
      });
    }
    return harnesses;
  }),
);
