#!/bin/sh
# The macOS match for images/linux/pixel.sh: the same commands and argv,
# through proofbox's input helper and screencapture. The Keeper already runs
# it in the desktop session of runner.
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

LOG=/var/lib/proofbox/action-log.jsonl

# BSD date has no %N; perl ships with macOS.
now() {
  /usr/bin/perl -MTime::HiRes=time -e 'printf "%.3f\n", time'
}

# log KIND [TO_X TO_Y]: append one line to the Action log. Call it right
# before the press, the first letter or key, or the capture.
log() {
  t=$(now)
  at=$("$INPUT" where)
  X=${at% *}
  Y=${at#* }
  if [ $# -ge 3 ]; then
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s,"toX":%s,"toY":%s}\n' "$t" "$1" "$X" "$Y" "$2" "$3" >> "$LOG"
  else
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s}\n' "$t" "$1" "$X" "$Y" >> "$LOG"
  fi
}

# shot: write a PNG of the screen to stdout at the screen's size in points
# (W x H), so a spot in it is the spot click, scroll, and drag take.
# screencapture writes 2x on a Retina screen; sips scales it down here,
# before the bytes cross the link.
shot() {
  f=$(mktemp /tmp/proofbox-shot.XXXXXX)
  p="$f.png"
  # `|| rc=$?` keeps set -e from leaving before the file is removed.
  rc=0
  { /usr/sbin/screencapture -x -t png "$p" && /usr/bin/sips -z "$H" "$W" "$p" >/dev/null && cat "$p"; } || rc=$?
  rm -f "$f" "$p"
  return "$rc"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  screenshot)
    log screenshot
    shot
    ;;
  click)
    # click X Y BUTTON GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    "$INPUT" move "$1" "$2" "$4"
    log click
    "$INPUT" click "$3"
    settle "$5"
    if [ "$6" = "1" ]; then
      shot
    fi
    ;;
  type)
    # type LETTER_MS SETTLE_MS SHOT TEXT
    log type
    "$INPUT" type "$1" "$4"
    settle "$2"
    if [ "$3" = "1" ]; then
      shot
    fi
    ;;
  key)
    # key KEYS SETTLE_MS SHOT
    log key
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
    log scroll
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
    "$INPUT" move "$1" "$2" "$5"
    log drag "$3" "$4"
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
