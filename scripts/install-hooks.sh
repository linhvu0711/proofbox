#!/usr/bin/env bash
# Turn on the git hooks that build dist/ again after a pull, a rebase, or a
# branch switch (scripts/rebuild.sh). pnpm install runs this.
# They are git config hooks (Git 2.54 or later), so they run beside the hooks
# folder a user set in core.hooksPath. Older git ignores them.
# Safe to run twice: each entry is set, not added.
# Never fails the install: on an error it warns and exits 0.
set -uo pipefail

cd "$(dirname "$0")/.." || { echo "install-hooks: cannot cd to the repo root, skipping"; exit 0; }

# A GitHub install has no .git: only a clone gets the hooks.
if [[ ! -e .git ]]; then
  echo "install-hooks: not a git checkout, skipping"
  exit 0
fi

# The test keeps a branch from before this script quiet: it has no rebuild.sh.
# Git appends the hook's own arguments to each command.
for pair in "merge post-merge" "checkout post-checkout" "rewrite post-rewrite"; do
  read -r name event <<<"$pair"
  if ! git config "hook.proofbox-rebuild-$name.command" "test ! -f scripts/rebuild.sh || bash scripts/rebuild.sh $event" \
    || ! git config "hook.proofbox-rebuild-$name.event" "$event"; then
    echo "install-hooks: could not set the git hooks, skipping"
    exit 0
  fi
done
echo "install-hooks: dist/ rebuilds after git pull, rebase, and branch switch"
