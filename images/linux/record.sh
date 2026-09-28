#!/bin/sh
set -eu

screen=$(xdotool getdisplaygeometry)
W=${screen% *}
H=${screen#* }

FFMPEG=/opt/proofbox/tools/ffmpeg
ROOT=/run/proofbox/recordings
CUR=$ROOT/recording
LOG=/run/proofbox/action-log.jsonl

# shot FILE: write a full-size PNG of the desktop to FILE.
shot() {
  "$FFMPEG" -loglevel error -f x11grab -video_size "${W}x${H}" -i "$DISPLAY" -frames:v 1 -f image2 -vcodec png -y "$1"
}

# log KIND [STEP]: append one line to the Action log.
log() {
  t=$(date +%s.%3N)
  eval "$(xdotool getmouselocation --shell)"
  if [ $# -ge 2 ]; then
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s,"step":%s}\n' "$t" "$1" "$X" "$Y" "$2" >> "$LOG"
  else
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s}\n' "$t" "$1" "$X" "$Y" >> "$LOG"
  fi
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  start)
    n=$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l)
    DIR=$ROOT/$((n + 1))
    mkdir -p "$DIR"
    date +%s.%3N > "$DIR/start"
    setsid "$FFMPEG" -f x11grab -framerate 30 -video_size "${W}x${H}" -draw_mouse 1 -i "$DISPLAY" -c:v libx264 -preset ultrafast -crf 18 -g 30 -pix_fmt yuv420p "$DIR/raw.mkv" < /dev/null > "$DIR/ffmpeg.log" 2>&1 &
    echo $! > "$DIR/pid"
    ln -s "$DIR" "$CUR"
    i=0
    while [ $i -lt 100 ]; do
      if grep -q 'frame=' "$DIR/ffmpeg.log" 2>/dev/null; then
        exit 0
      fi
      sleep 0.1
      i=$((i + 1))
    done
    cat "$DIR/ffmpeg.log" >&2
    exit 1
    ;;
  stop)
    DIR=$(readlink "$CUR")
    kill -TERM "$(cat "$DIR/pid")"
    i=0
    while [ $i -lt 100 ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; do
      sleep 0.1
      i=$((i + 1))
    done
    date +%s.%3N > "$DIR/stop"
    rm "$CUR"
    steps=$(cat "$DIR/steps" 2>/dev/null || echo 0)
    printf '{"dir":"%s","start":%s,"stop":%s,"steps":%s,"width":%s,"height":%s}\n' "$DIR" "$(cat "$DIR/start")" "$(cat "$DIR/stop")" "$steps" "$W" "$H"
    ;;
  mark)
    # mark LABEL: start a new numbered step with its caption text.
    DIR=$(readlink "$CUR")
    n=$(cat "$DIR/steps" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$1" > "$DIR/caption-$n.txt"
    echo "$n" > "$DIR/steps"
    log mark "$n"
    ;;
  probe)
    # probe DIR: print the Duration line and each freezedetect mark of raw.mkv.
    "$FFMPEG" -hide_banner -nostats -i "$1/raw.mkv" -vf freezedetect=n=0.001:d=3 -an -f null - 2>&1 | grep -E 'Duration:|lavfi.freezedetect'
    ;;
  build)
    # build DIR CRF: the filter script comes on stdin; write proof.mp4 and
    # print its byte size.
    cat > "$1/edit.txt"
    "$FFMPEG" -y -hide_banner -loglevel error -/filter_complex "$1/edit.txt" -map '[out]' -c:v libx264 -preset medium -crf "$2" -pix_fmt yuv420p -profile:v high -movflags +faststart "$1/proof.mp4"
    wc -c < "$1/proof.mp4"
    ;;
  fetch)
    # fetch FILE: write FILE to stdout.
    cat "$1"
    ;;
  *)
    printf 'record: unknown command %s\n' "$cmd" >&2
    exit 2
    ;;
esac
