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

git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
# A linked worktree builds nothing: the global link points at the main checkout.
[[ "$git_dir" == "$common_dir" ]] || exit 0

case "$event" in
  post-merge) ;;
  post-checkout)
    # Args: old head, new head, 1 for a branch checkout. A rebase builds once,
    # at its end, from post-rewrite.
    [[ "${3:-}" == "1" && "${1:-}" != "${2:-}" ]] || exit 0
    [[ ! -d "$git_dir/rebase-merge" && ! -d "$git_dir/rebase-apply" ]] || exit 0
    ;;
  post-rewrite)
    # An amend leaves the files as they were.
    [[ "${1:-}" == "rebase" ]] || exit 0
    ;;
  *) exit 0 ;;
esac

# A repeat install with an unchanged lockfile does not build, so build too.
log=$(mktemp) || exit 0
if pnpm install --frozen-lockfile >"$log" 2>&1 && pnpm run build >>"$log" 2>&1; then
  echo "rebuild: built dist/"
fi
rm -f "$log"
exit 0
