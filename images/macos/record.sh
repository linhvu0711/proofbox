#!/bin/sh
# The macOS match for images/linux/record.sh: the same commands and argv,
# through avfoundation, screencapture, and proofbox's input helper.
set -eu

INPUT=/opt/proofbox/tools/input
screen=$("$INPUT" size)
W=${screen% *}
H=${screen#* }

FFMPEG=/opt/proofbox/tools/ffmpeg
ROOT=/var/lib/proofbox/recordings
CUR=$ROOT/recording
LOG=/var/lib/proofbox/action-log.jsonl

# BSD date has no %N; perl ships with macOS.
now() {
  /usr/bin/perl -MTime::HiRes=time -e 'printf "%.3f\n", time'
}

# shot FILE: write a full-size PNG of the desktop to FILE.
shot() {
  /usr/sbin/screencapture -x -t png "$1"
}

# log KIND [STEP]: append one line to the Action log.
log() {
  t=$(now)
  at=$("$INPUT" where)
  X=${at% *}
  Y=${at#* }
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
    if [ -L "$CUR" ]; then
      exit 4
    fi
    n=0
    while [ -e "$ROOT/$((n + 1))" ]; do
      n=$((n + 1))
    done
    DIR=$ROOT/$((n + 1))
    mkdir "$DIR" 2>/dev/null || exit 4
    now > "$DIR/start"
    # No setsid and no working nohup on a Mac: a subshell that swallows
    # HUP and execs ffmpeg survives the ssh session ending.
    (trap '' HUP; exec "$FFMPEG" -nostdin -f avfoundation -capture_cursor 1 -framerate 30 -i 'Capture screen 0' -c:v libx264 -preset ultrafast -crf 18 -g 30 -pix_fmt yuv420p "$DIR/raw.mkv") < /dev/null > "$DIR/ffmpeg.log" 2>&1 &
    echo $! > "$DIR/pid"
    if ! ln -s "$DIR" "$CUR" 2>/dev/null; then
      kill -TERM "$(cat "$DIR/pid")" 2>/dev/null || true
      exit 4
    fi
    i=0
    while [ $i -lt 100 ]; do
      elapsed=$(tr '\r' '\n' < "$DIR/ffmpeg.log" 2>/dev/null | sed -n 's/.*time=\([0-9:.]*\).*/\1/p' | tail -1)
      if [ -n "$elapsed" ]; then
        secs=$(printf '%s' "$elapsed" | awk -F: '{printf "%.3f", $1*3600+$2*60+$3}')
        now | awk -v s="$secs" '{printf "%.3f", $1 - s}' > "$DIR/start"
        exit 0
      fi
      sleep 0.1
      i=$((i + 1))
    done
    cat "$DIR/ffmpeg.log" >&2
    kill -TERM "$(cat "$DIR/pid")" 2>/dev/null || true
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
    pid=$(cat "$DIR/pid")
    # A macOS capture can stop, stall, or be blocked by a privacy alert;
    # name which before the walk ends silently with a half video.
    blocked=""
    if ! kill -0 "$pid" 2>/dev/null; then
      blocked="the capture stopped"
    else
      last=$(tr '\r' '\n' < "$DIR/ffmpeg.log" 2>/dev/null | sed -n 's/.*time=\([0-9:.]*\).*/\1/p' | tail -1)
      secs=$(printf '%s' "$last" | awk -F: '{printf "%.3f", $1*3600+$2*60+$3}')
      lag=$(now | awk -v s="$(cat "$DIR/start")" -v e="$secs" '{printf "%.3f", $1 - s - e}')
      if [ "$(awk -v l="$lag" 'BEGIN { print (l > 5) ? 1 : 0 }')" = "1" ]; then
        blocked="the capture stalled"
      fi
    fi
    if [ -z "$blocked" ]; then
      hint=$(plutil -extract '/opt/namespace/vmguest.kScreenCapturePrivacyHintDate' raw "/Users/runner/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist" 2>/dev/null || true)
      if [ "$hint" != "4000-01-01T00:00:00Z" ]; then
        blocked="an alert is on screen"
      fi
    fi
    if [ -n "$blocked" ]; then
      shot "$DIR/blocked.png" || true
      kill -CONT "$pid" 2>/dev/null || true
    fi
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while [ $i -lt 100 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1
      i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    now > "$DIR/stop"
    rm "$CUR"
    if [ -n "$blocked" ]; then
      printf '{"dir":"%s","start":%s,"stop":%s,"steps":%s,"width":%s,"height":%s,"blocked":"%s"}\n' "$DIR" "$(cat "$DIR/start")" "$(cat "$DIR/stop")" "$steps" "$W" "$H" "$blocked"
    else
      printf '{"dir":"%s","start":%s,"stop":%s,"steps":%s,"width":%s,"height":%s}\n' "$DIR" "$(cat "$DIR/start")" "$(cat "$DIR/stop")" "$steps" "$W" "$H"
    fi
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
