#!/bin/bash
# Install git hooks for skill-engine. Idempotent.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_SRC="$REPO_ROOT/hooks/git"
HOOKS_DST="$REPO_ROOT/.git/hooks"

for HOOK in "$HOOKS_SRC"/*; do
  NAME=$(basename "$HOOK")
  [ "$NAME" = "setup-hooks.sh" ] && continue
  [ ! -f "$HOOK" ] && continue

  TARGET="$HOOKS_DST/$NAME"
  if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$HOOK" ]; then
    echo "$NAME: already installed"
    continue
  fi

  ln -sf "$HOOK" "$TARGET"
  echo "$NAME: installed"
done
