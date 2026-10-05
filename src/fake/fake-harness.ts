import { Command } from "@effect/platform";
import { Clock, Effect, Either, Option, Schema } from "effect";
import { CliOutput } from "../cli-output.ts";
import { HarnessLoginError } from "../errors.ts";
import type { FileLoginTool, Harness } from "../harness.ts";
import { lastRefreshOf } from "../login/logins-file.ts";

const End = Schema.Struct({
  type: Schema.Literal("end"),
  session: Schema.String,
  message: Schema.String,
  error: Schema.optional(Schema.Literal("login", "usage-limit", "other")),
  resets: Schema.optional(Schema.String),
});

const Activity = Schema.Struct({
  type: Schema.Literal("activity"),
  text: Schema.String,
});

const Said = Schema.Struct({
  type: Schema.Literal("said"),
  text: Schema.String,
});

const FAKE_HARNESS_SCRIPT = String.raw`#!/bin/sh
set -eu
shift
session=fake-$$
if [ "$1" = --resume ]; then session=$2; shift 2; fi
prompt=$1
code=0
mkdir -p "$HOME/.fake-harness/sessions"
history="$HOME/.fake-harness/sessions/$session"
heard=$(paste -sd ';' "$history" 2>/dev/null || true)
printf '%s\n' "$prompt" >> "$history"
echo '{"type":"activity","text":"read the prompt"}'
case "$prompt" in
  'sleep '*)
    n=$(printf '%s' "$prompt" | cut -d ' ' -f 2)
    printf '{"type":"activity","text":"sleeping %ss"}\n' "$n"
    sleep "$n"
    message="slept $n"s
    ;;
  recall) message="remembers: $heard" ;;
  'fail login')
    printf '{"type":"end","session":"%s","error":"login","message":"401 login refused"}\n' "$session"
    exit 1
    ;;
  'fail usage-limit')
    printf '{"type":"end","session":"%s","error":"usage-limit","message":"usage limit reached","resets":"2026-10-05T03:00:00Z"}\n' "$session"
    exit 1
    ;;
  crash) echo 'fake-harness: crashed on purpose' >&2; exit 3 ;;
  'done then exit 2') message="did: $prompt"; code=2 ;;
  'stderr marker') echo proofbox-turn-err >&2; message="did: $prompt" ;;
  long)
    x=$(printf '%200s' '' | tr ' ' x)
    printf '{"type":"said","text":"%s\\nsecond line"}\n' "$x"
    message="did: $prompt"
    ;;
  *) message="did: $prompt" ;;
esac
perl -MJSON::PP -e 'print encode_json({type => "end", session => $ARGV[0], message => $ARGV[1]}), "\n"' "$session" "$message"
exit "$code"
`;

export const makeFakeHarness = (name: string): Harness => ({
  name,
  install: () =>
    `set -eu\nmkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/fake-harness" <<'PROOFBOX_FAKE_HARNESS'\n${FAKE_HARNESS_SCRIPT}\nPROOFBOX_FAKE_HARNESS\nchmod 755 "$HOME/.local/bin/fake-harness"`,
  home: ".fake-harness",
  homeEntries: [".local"],
  instructionsFile: "AGENTS.md",
  turn: ({ prompt, session }) => [
    "sh",
    "-c",
    'exec "$HOME/.local/bin/fake-harness" "$@"',
    "sh",
    "turn",
    ...(Option.isSome(session) ? ["--resume", session.value] : []),
    prompt,
  ],
  readEnd: (output) => {
    try {
      const end = Schema.decodeUnknownEither(End)(
        JSON.parse(output.trimEnd().split("\n").at(-1) ?? ""),
      );
      if (Either.isRight(end) && end.right.error !== undefined) {
        return {
          _tag: "Failed",
          session: Option.some(end.right.session),
          kind: end.right.error,
          message: end.right.message,
          resets: Option.fromNullable(end.right.resets),
        };
      }
      return Either.isRight(end)
        ? {
            _tag: "Done",
            session: end.right.session,
            lastMessage: end.right.message,
          }
        : { _tag: "NoEnd" };
    } catch {
      return { _tag: "NoEnd" };
    }
  },
  readSteps: (event) => {
    const said = Schema.decodeUnknownEither(Schema.parseJson(Said))(event);
    if (Either.isRight(said)) return [{ kind: "said", text: said.right.text }];
    const activity = Schema.decodeUnknownEither(Schema.parseJson(Activity))(
      event,
    );
    return Either.isRight(activity)
      ? [{ kind: "tool", text: activity.right.text }]
      : [];
  },
});

const FakeLogin = Schema.Struct({
  account: Schema.optional(Schema.String),
  // biome-ignore lint/style/useNamingConvention: Codex auth.json field.
  last_refresh: Schema.String,
  renewals: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  // biome-ignore lint/style/useNamingConvention: Fake auth.json field.
  fail_renew: Schema.optional(Schema.Boolean),
});

const writeFakeLogin = Effect.fn("fakeHarness.writeFakeLogin")(
  (home: string, text: string) =>
    Command.exitCode(
      Command.make(
        "sh",
        "-c",
        'set -eu; umask 077; printf "%s" "$2" > "$1/auth.json"',
        "sh",
        home,
        text,
      ),
    ).pipe(
      Effect.flatMap((code) =>
        code === 0
          ? Effect.void
          : Effect.fail(
              new HarnessLoginError({
                harness: "fake-file",
                reason: "fake login failed",
                nothing: "saved",
              }),
            ),
      ),
      Effect.mapError(
        () =>
          new HarnessLoginError({
            harness: "fake-file",
            reason: "fake login failed",
            nothing: "saved",
          }),
      ),
    ),
);

export const makeFakeFileLogin = (): FileLoginTool => ({
  login: Effect.fn("fakeHarness.login")(function* (home: string) {
    const output = yield* CliOutput;
    yield* output.err(
      "Open https://example.invalid/device and enter FAKE-CODE\n",
    );
    yield* writeFakeLogin(
      home,
      '{"last_refresh":"2026-10-05T00:00:00Z","renewals":0}\n',
    );
  }),
  renew: Effect.fn("fakeHarness.renew")(function* (home: string) {
    const bad = () =>
      new HarnessLoginError({
        harness: "fake-file",
        reason: "fake renewal failed",
        nothing: "created",
      });
    const text = yield* Command.string(
      Command.make("cat", `${home}/auth.json`),
    ).pipe(Effect.mapError(bad));
    const login = yield* Schema.decodeUnknown(Schema.parseJson(FakeLogin))(
      text,
    ).pipe(Effect.mapError(bad));
    if (login.fail_renew === true) return yield* bad();
    const now = yield* Clock.currentTimeMillis;
    const renewed = {
      ...login,
      // biome-ignore lint/style/useNamingConvention: Codex auth.json field.
      last_refresh: new Date(now).toISOString(),
      renewals: login.renewals + 1,
    };
    yield* writeFakeLogin(home, `${JSON.stringify(renewed)}\n`);
  }),
  renewedAt: lastRefreshOf,
  accountOf: (text) =>
    Schema.decodeUnknownOption(
      Schema.parseJson(
        Schema.Struct({ account: Schema.optional(Schema.String) }),
      ),
    )(text).pipe(Option.map((login) => login.account ?? "fake")),
});
