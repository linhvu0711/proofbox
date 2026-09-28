#!/bin/sh
set -eu

screen=$(xdpyinfo | awk '/dimensions:/ { split($2, s, "x"); print s[1], s[2] }')
W=${screen% *}
H=${screen#* }

cmd=${1:-}
case "$cmd" in
  screenshot)
    exec /opt/proofbox/tools/ffmpeg -loglevel error -f x11grab -video_size "${W}x${H}" -i "$DISPLAY" -frames:v 1 -f image2pipe -vcodec png -
    ;;
  *)
    printf 'pixel: unknown command %s\n' "$cmd" >&2
    exit 2
    ;;
esac
