#!/bin/sh
set -eu

mkdir -p /run/proofbox
printf '%s\n' "$PROOFBOX_DEADLINE" > /run/proofbox/deadline
chmod 0755 /run/proofbox
chmod 0644 /run/proofbox/deadline
install -o app -g app -m 0644 /dev/null /run/proofbox/action-log.jsonl
install -d -o app -g app -m 0755 /run/proofbox/recordings

env HOME=/home/app runuser -u app -- sh -c 'while :; do Xvfb :99 -screen 0 1440x900x24 -nolisten tcp; sleep 1; done' &
env HOME=/home/app runuser -u app -- sh -c 'while :; do until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.2; done; fluxbox; sleep 1; done' &

while true; do
  deadline=$(cat /run/proofbox/deadline 2>/dev/null || printf '0')
  case "$deadline" in
    ''|*[!0-9]*) deadline=0 ;;
  esac
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ] || [ "$now" -ge "$PROOFBOX_MAX_LIFE_AT" ]; then
    exit 0
  fi
  sleep 1
done
