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
    const claude = yield* Effect.cached(
      importFor("claude", () => import("./claude-harness.ts")).pipe(
        Effect.map((module) => module.makeClaudeHarness()),
      ),
    );
    const harnesses = new Map<string, HarnessEntry>([
      [
        "claude",
        {
          name: "claude",
          login: {
            _tag: "Env",
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
          load: claude,
        },
      ],
      [
        "codex",
        {
          name: "codex",
          login: {
            _tag: "Env",
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
          Effect.map((module) => module.makeFakeHarness("fake")),
        ),
      );
      harnesses.set("fake", {
        name: "fake",
        login: {
          _tag: "Env",
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
      const fakeFile = yield* Effect.cached(
        importFor("fake-file", () => import("./fake/fake-harness.ts")),
      );
      harnesses.set("fake-file", {
        name: "fake-file",
        login: {
          _tag: "File",
          what: "fake plan login",
          file: "auth.json",
          howToMake: "It runs a fake login",
          renewAfter: Duration.days(7),
          load: Effect.map(fakeFile, (module) => module.makeFakeFileLogin()),
        },
        profile: {
          home: ".fake-harness",
          parts: ["AGENTS.md", "skills/"],
          leftOut: "settings",
        },
        load: Effect.map(fakeFile, (module) =>
          module.makeFakeHarness("fake-file"),
        ),
      });
    }
    return harnesses;
  }),
);
