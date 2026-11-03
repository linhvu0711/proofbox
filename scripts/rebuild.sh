#!/usr/bin/env bash
# Build dist/ again after git changes the files of the checkout, so a linked
# `proofbox` runs the code you see. scripts/install-hooks.sh registers it.
# Usage: rebuild.sh <event> <the hook's own arguments>
# No -e: a hook must never fail the git command that ran it.
set -uo pipefail

event=${1:-}
shift

cd "$(dirname "$0")/.." || exit 0
# Git sets these for a hook, and pnpm install runs sync-repos.sh, which clones.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

case "$event" in
  post-merge) ;;
  *) exit 0 ;;
esac

# A repeat install with an unchanged lockfile does not build, so build too.
log=$(mktemp) || exit 0
if pnpm install --frozen-lockfile >"$log" 2>&1 && pnpm run build >>"$log" 2>&1; then
  echo "rebuild: built dist/"
fi
rm -f "$log"
exit 0
