#!/bin/zsh
set -euo pipefail
# Thin wrapper → Python implementation (hex task suffixes break zsh assoc arrays).
exec python3 "${0:a:h}/prune_studio_worktrees.py" "$@"
