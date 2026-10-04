import { Duration, Effect, Layer, Option } from "effect";
import { HarnessError } from "./errors.ts";
import { type HarnessEntry, Harnesses } from "./harness.ts";

export const HarnessesLive = Layer.effect(
  Harnesses,
  Effect.sync(() => {
    return new Map<string, HarnessEntry>([
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
  }),
);
