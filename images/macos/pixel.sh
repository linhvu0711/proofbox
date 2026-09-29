#!/bin/sh
# The macOS match for images/linux/pixel.sh: the same commands and argv,
# through proofbox's input helper and screencapture. The Keeper already runs
# it in the desktop session of runner. No Action log until Recording on
# macOS (#15).
set -eu

INPUT=/opt/proofbox/tools/input

screen=$("$INPUT" size)
W=${screen% *}
H=${screen#* }

# inside X Y: refuse a point that is outside the screen.
inside() {
  if [ "$1" -lt 0 ] || [ "$2" -lt 0 ] || [ "$1" -ge "$W" ] || [ "$2" -ge "$H" ]; then
    printf '%s %s\n' "$W" "$H"
    exit 3
  fi
}

# settle MS: wait MS milliseconds for the screen to catch up.
settle() {
  sleep "$(awk "BEGIN { print $1 / 1000 }")"
}

# shot: write a full-size PNG of the screen to stdout.
shot() {
  f=$(mktemp /tmp/proofbox-shot.XXXXXX)
  # `|| rc=$?` keeps set -e from leaving before the file is removed.
  rc=0
  { /usr/sbin/screencapture -x -t png "$f" && cat "$f"; } || rc=$?
  rm -f "$f"
  return "$rc"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  screenshot)
    shot
    ;;
  click)
    # click X Y BUTTON GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    "$INPUT" move "$1" "$2" "$4"
    "$INPUT" click "$3"
    settle "$5"
    if [ "$6" = "1" ]; then
      shot
    fi
    ;;
  type)
    # type LETTER_MS SETTLE_MS SHOT TEXT
    "$INPUT" type "$1" "$4"
    settle "$2"
    if [ "$3" = "1" ]; then
      shot
    fi
    ;;
  key)
    # key KEYS SETTLE_MS SHOT
    "$INPUT" key "$1"
    settle "$2"
    if [ "$3" = "1" ]; then
      shot
    fi
    ;;
  scroll)
    # scroll X Y BUTTON STEPS GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    "$INPUT" move "$1" "$2" "$5"
    "$INPUT" scroll "$3" "$4"
    settle "$6"
    if [ "$7" = "1" ]; then
      shot
    fi
    ;;
  drag)
    # drag X1 Y1 X2 Y2 GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    inside "$3" "$4"
    "$INPUT" drag "$1" "$2" "$3" "$4" "$5"
    settle "$6"
    if [ "$7" = "1" ]; then
      shot
    fi
    ;;
  *)
    printf 'pixel: unknown command %s\n' "$cmd" >&2
    exit 2
    ;;
esac
