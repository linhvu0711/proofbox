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

# log KIND [STEP|REASON]: append one line to the Action log; a Wait mark's
# second word is the reason as a JSON string.
log() {
  t=$(date +%s.%3N)
  eval "$(xdotool getmouselocation --shell)"
  if [ "$1" = wait ]; then
    printf '{"t":%s,"kind":"wait","x":%s,"y":%s,"reason":%s}\n' "$t" "$X" "$Y" "$2" >> "$LOG"
  elif [ $# -ge 2 ]; then
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s,"step":%s}\n' "$t" "$1" "$X" "$Y" "$2" >> "$LOG"
  else
    printf '{"t":%s,"kind":"%s","x":%s,"y":%s}\n' "$t" "$1" "$X" "$Y" >> "$LOG"
  fi
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  start)
    if [ -L "$CUR" ]; then
      exit 4
    fi
    n=0
    while [ -e "$ROOT/$((n + 1))" ]; do
      n=$((n + 1))
    done
    DIR=$ROOT/$((n + 1))
    mkdir "$DIR" 2>/dev/null || exit 4
    date +%s.%3N > "$DIR/start"
    setsid "$FFMPEG" -f x11grab -framerate 30 -video_size "${W}x${H}" -draw_mouse 1 -i "$DISPLAY" -c:v libx264 -preset ultrafast -crf 18 -g 30 -pix_fmt yuv420p "$DIR/raw.mkv" < /dev/null > "$DIR/ffmpeg.log" 2>&1 &
    echo $! > "$DIR/pid"
    if ! ln -s "$DIR" "$CUR" 2>/dev/null; then
      kill -TERM "$(cat "$DIR/pid")" 2>/dev/null || true
      exit 4
    fi
    i=0
    while [ $i -lt 100 ]; do
      elapsed=$(sed -n 's/.*time=\([0-9:.]*\).*/\1/p' "$DIR/ffmpeg.log" 2>/dev/null | head -1)
      if [ -n "$elapsed" ]; then
        secs=$(printf '%s' "$elapsed" | awk -F: '{printf "%.3f", $1*3600+$2*60+$3}')
        date +%s.%3N | awk -v s="$secs" '{printf "%.3f", $1 - s}' > "$DIR/start"
        exit 0
      fi
      sleep 0.1
      i=$((i + 1))
    done
    cat "$DIR/ffmpeg.log" >&2
    kill -TERM "$(cat "$DIR/pid")" 2>/dev/null || true
    # dash and macOS sh both have -ef; ShellCheck before 0.10 says it is not POSIX.
    # shellcheck disable=SC3013
    if [ "$DIR" -ef "$CUR" ]; then
      rm -f "$CUR"
    fi
    exit 1
    ;;
  stop)
    if [ ! -L "$CUR" ]; then
      exit 5
    fi
    DIR=$(readlink "$CUR")
    steps=$(cat "$DIR/steps" 2>/dev/null || echo 0)
    if [ "$steps" -ge 1 ]; then
      shot "$DIR/shot-$steps.png"
    fi
    kill -TERM "$(cat "$DIR/pid")"
    i=0
    while [ $i -lt 100 ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; do
      sleep 0.1
      i=$((i + 1))
    done
    date +%s.%3N > "$DIR/stop"
    rm "$CUR"
    printf '{"dir":"%s","start":%s,"stop":%s,"steps":%s,"width":%s,"height":%s}\n' "$DIR" "$(cat "$DIR/start")" "$(cat "$DIR/stop")" "$steps" "$W" "$H"
    ;;
  mark)
    # mark LABEL: save the closing shot of the step now ending, then start
    # a new numbered step with its caption text.
    if [ ! -L "$CUR" ]; then
      exit 5
    fi
    DIR=$(readlink "$CUR")
    n=$(cat "$DIR/steps" 2>/dev/null || echo 0)
    if [ "$n" -ge 1 ]; then
      shot "$DIR/shot-$n.png"
    fi
    n=$((n + 1))
    printf '%s' "$1" > "$DIR/caption-$n.txt"
    echo "$n" > "$DIR/steps"
    log mark "$n"
    ;;
  wait)
    # wait REASON: add a Wait mark to the Action log; REASON is a JSON string.
    if [ ! -L "$CUR" ]; then
      exit 5
    fi
    log wait "$1"
    ;;
  probe)
    # probe DIR [D]: print the Duration line and each freezedetect mark of
    # raw.mkv; D is the still-part threshold in seconds (3 when not given).
    "$FFMPEG" -hide_banner -nostats -i "$1/raw.mkv" -vf "freezedetect=n=0.001:d=${2:-3}" -an -f null - 2>&1 | grep -E 'Duration:|lavfi.freezedetect'
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
