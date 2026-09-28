#!/bin/sh
set -eu

mkdir -p /run/proofbox
printf '%s\n' "$PROOFBOX_DEADLINE" > /run/proofbox/deadline
chmod 0755 /run/proofbox
chmod 0644 /run/proofbox/deadline

env HOME=/home/app runuser -u app -- Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
env HOME=/home/app runuser -u app -- sh -c 'until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done; exec fluxbox' &

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
