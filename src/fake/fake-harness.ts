import { Either, Option, Schema } from "effect";
import type { Harness } from "../harness.ts";

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
  *) message="did: $prompt" ;;
esac
perl -MJSON::PP -e 'print encode_json({type => "end", session => $ARGV[0], message => $ARGV[1]}), "\n"' "$session" "$message"
exit "$code"
`;

export const makeFakeHarness = (): Harness => ({
  name: "fake",
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
  readActivity: (output) => {
    for (const line of output.trimEnd().split("\n").reverse()) {
      const activity = Schema.decodeUnknownEither(Schema.parseJson(Activity))(
        line,
      );
      if (Either.isRight(activity)) return Option.some(activity.right.text);
    }
    return Option.none();
  },
});
