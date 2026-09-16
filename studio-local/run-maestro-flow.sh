#!/bin/zsh
set -euo pipefail
# Usage: ./studio-local/run-maestro-flow.sh [flow.yaml] [udid]
# One-command: boot sim (if needed) + maestro test + evidence under
#   studio-local/ui-test/out/maestro/<stamp>/
# Exit 2 = app still missing after install-app-on-sim.sh attempt.

ROOT=${0:a:h}/..
cd "$ROOT"
export PATH="$HOME/.maestro/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"

FLOW=${1:-/Users/abdullah/Documents/projects/pocket-love/.maestro/onboard.yaml}
# Prefer free studio reserve (17 Pro); callers may override. Script falls back
# to any booted/shutdown sim that already has the app if preferred lacks it.
PREFERRED_UDID=${2:-812A595B-0FDA-4C3F-9346-088E6C07A489}
APP_ID=app.pocketlove.private
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$ROOT/studio-local/ui-test/out/maestro/$STAMP"
mkdir -p "$OUT"

if ! command -v maestro >/dev/null; then
  echo "maestro not on PATH (expected ~/.maestro/bin/maestro)" | tee "$OUT/error.txt"
  exit 1
fi

has_app() {
  local udid=$1
  xcrun simctl get_app_container "$udid" "$APP_ID" data >/dev/null 2>&1
}

pick_udid() {
  local want=$1
  if has_app "$want"; then
    echo "$want"
    return
  fi
  # Prefer a Booted sim that already has the app (AO/dev may leave one warm).
  local line udid
  while IFS= read -r line; do
    udid=${line:s/\(/}
    udid=${udid%%)*}
    udid=$(echo "$line" | sed -n 's/.*(\([A-F0-9-]\{36\}\)).*/\1/p')
    [[ -n "$udid" ]] || continue
    if has_app "$udid"; then
      echo "$udid"
      return
    fi
  done < <(xcrun simctl list devices available | grep '(Booted)')
  while IFS= read -r line; do
    udid=$(echo "$line" | sed -n 's/.*(\([A-F0-9-]\{36\}\)).*/\1/p')
    [[ -n "$udid" ]] || continue
    if has_app "$udid"; then
      echo "$udid"
      return
    fi
  done < <(xcrun simctl list devices available | grep -E 'iPhone')
  echo "$want"
}

# Prefer the reserved studio sim. Auto-install below fills a missing app
# instead of hopping to another device (hopping hid the install path).
UDID=$PREFERRED_UDID

{
  echo "maestro=$(maestro --version 2>/dev/null | head -1)"
  echo "preferred_udid=$PREFERRED_UDID"
  echo "udid=$UDID"
  echo "flow=$FLOW"
  echo "out=$OUT"
} | tee "$OUT/meta.txt"

xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator
for i in {1..45}; do
  if xcrun simctl list devices | grep "$UDID" | grep -q '(Booted)'; then
    echo "sim_state=(Booted) wait_s=$i" | tee -a "$OUT/meta.txt"
    break
  fi
  sleep 1
done

PROJECT=${STUDIO_MAESTRO_PROJECT:-/Users/abdullah/Documents/projects/pocket-love}
# Auto-install when missing, or when STUDIO_MAESTRO_INSTALL=1 forces refresh.
if [[ "${STUDIO_MAESTRO_INSTALL:-0}" == "1" ]] || ! has_app "$UDID"; then
  echo "install: starting (force=${STUDIO_MAESTRO_INSTALL:-0})" | tee -a "$OUT/meta.txt"
  set +e
  "$ROOT/studio-local/install-app-on-sim.sh" "$PROJECT" "$UDID" "$APP_ID" 2>&1 | tee "$OUT/install.log"
  install_code=${pipestatus[1]}
  set -e
  echo "install_exit=$install_code" | tee -a "$OUT/meta.txt"
  if ! has_app "$UDID"; then
    echo "APP_NOT_INSTALLED:$APP_ID on $UDID after install_exit=$install_code" | tee "$OUT/blocker.txt"
    echo "See install.log. Canonical: npx expo run:ios --device $UDID --configuration Debug --no-bundler" | tee -a "$OUT/blocker.txt"
    exit 2
  fi
fi

# Dirty-sim fix: wipe app data so onboard (and similar) land on first-run UI.
# Default ON; set STUDIO_MAESTRO_RESET=0 to skip. clearState in onboard.yaml is belt-and-suspenders.
if [[ "${STUDIO_MAESTRO_RESET:-1}" != "0" ]] && has_app "$UDID"; then
  echo "reset: starting" | tee -a "$OUT/meta.txt"
  set +e
  "$ROOT/studio-local/reset-app-on-sim.sh" "$UDID" "$APP_ID" 2>&1 | tee "$OUT/reset.log"
  reset_code=${pipestatus[1]}
  set -e
  echo "reset_exit=$reset_code" | tee -a "$OUT/meta.txt"
  if [[ $reset_code -ne 0 ]]; then
    echo "APP_RESET_FAILED:$APP_ID on $UDID" | tee "$OUT/blocker.txt"
    exit 2
  fi
else
  echo "reset: skipped" | tee -a "$OUT/meta.txt"
fi

set +e
maestro test --udid "$UDID" \
  --test-output-dir "$OUT/artifacts" \
  --debug-output "$OUT/debug" \
  --flatten-debug-output \
  "$FLOW" 2>&1 | tee "$OUT/maestro.log"
code=${pipestatus[1]}
set -e
echo "exit=$code" | tee -a "$OUT/meta.txt"
# Also keep a copy of ~/.maestro/tests latest if artifacts empty
cp -R "$HOME/.maestro/tests" "$OUT/maestro-tests-home" 2>/dev/null || true
echo "EVIDENCE=$OUT"
exit $code
