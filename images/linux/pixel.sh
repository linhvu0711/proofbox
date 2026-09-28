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
  # shellcheck disable=SC2046
  xdotool $(awk -v x0="$X" -v y0="$Y" -v x1="$1" -v y1="$2" -v ms="$3" 'BEGIN {
    n = int((ms + 19) / 20)
    for (i = 1; i <= n; i++) {
      p = i / n
      e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ^ 2 / 2
      printf "mousemove %.0f %.0f sleep %s ", x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, ms / n / 1000
    }
  }')
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

# shot: write a full-size PNG of the desktop to stdout.
shot() {
  /opt/proofbox/tools/ffmpeg -loglevel error -f x11grab -video_size "${W}x${H}" -i "$DISPLAY" -frames:v 1 -f image2pipe -vcodec png -
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
    glide "$1" "$2" "$4"
    xdotool click "$3"
    settle "$5"
    if [ "$6" = "1" ]; then
      shot
    fi
    ;;
  *)
    printf 'pixel: unknown command %s\n' "$cmd" >&2
    exit 2
    ;;
esac
