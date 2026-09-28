#!/bin/sh
set -eu

screen=$(xdotool getdisplaygeometry)
W=${screen% *}
H=${screen#* }

# glide X Y MS: move the pointer to X Y over MS milliseconds, easing in and
# out in steps of about 20 ms. MS 0 jumps straight there.
glide() {
  if [ "$3" -eq 0 ]; then
    xdotool mousemove "$1" "$2"
    return
  fi
  eval "$(xdotool getmouselocation --shell)"
  # One xdotool call per 200 steps keeps the command line under the argument
  # limit no matter how long the glide is.
  awk -v x0="$X" -v y0="$Y" -v x1="$1" -v y1="$2" -v ms="$3" 'BEGIN {
    n = int((ms + 19) / 20)
    for (i = 1; i <= n; i++) {
      p = i / n
      e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ^ 2 / 2
      printf "mousemove %.0f %.0f sleep %s", x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, ms / n / 1000
      if (i % 200 == 0 || i == n) printf "\n"; else printf " "
    }
  }' | while IFS= read -r batch; do
    # shellcheck disable=SC2086
    xdotool $batch || exit 1
  done
}

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

LOG=/run/proofbox/action-log.jsonl

# log KIND [TO_X TO_Y]: append one line to the Action log. Call it right
# before the press, the first letter or key, or the capture.
log() {
  t=$(date +%s.%3N)
  eval "$(xdotool getmouselocation --shell)"
  if [ $# -ge 3 ]; then
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s,"toX":%s,"toY":%s}\n' "$t" "$1" "$X" "$Y" "$2" "$3" >> "$LOG"
  else
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s}\n' "$t" "$1" "$X" "$Y" >> "$LOG"
  fi
}

# shot: write a full-size PNG of the desktop to stdout.
shot() {
  /opt/proofbox/tools/ffmpeg -loglevel error -f x11grab -video_size "${W}x${H}" -i "$DISPLAY" -frames:v 1 -f image2pipe -vcodec png -
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
    glide "$1" "$2" "$4"
    log click
    xdotool click "$3"
    settle "$5"
    if [ "$6" = "1" ]; then
      shot
    fi
    ;;
  type)
    # type LETTER_MS SETTLE_MS SHOT TEXT
    log type
    xdotool type --delay "$1" "$4"
    settle "$2"
    if [ "$3" = "1" ]; then
      shot
    fi
    ;;
  key)
    # key KEYS SETTLE_MS SHOT
    log key
    xdotool key "$1"
    settle "$2"
    if [ "$3" = "1" ]; then
      shot
    fi
    ;;
  scroll)
    # scroll X Y BUTTON STEPS GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    glide "$1" "$2" "$5"
    log scroll
    xdotool click --repeat "$4" --delay 50 "$3"
    settle "$6"
    if [ "$7" = "1" ]; then
      shot
    fi
    ;;
  drag)
    # drag X1 Y1 X2 Y2 GLIDE_MS SETTLE_MS SHOT
    inside "$1" "$2"
    inside "$3" "$4"
    glide "$1" "$2" "$5"
    log drag "$3" "$4"
    xdotool mousedown 1
    glide "$3" "$4" "$5"
    xdotool mouseup 1
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
