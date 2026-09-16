#!/bin/zsh
# Double-click entry point. Resolves its own location so it works regardless of Finder's or the
# Terminal's current directory, then delegates to ./studio, which does the real idempotent work.
HERE=${0:a:h}
cd "$HERE"
./studio start
echo
echo "Press any key to close this window..."
read -k 1
