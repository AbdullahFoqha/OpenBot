#!/bin/zsh
set -euo pipefail
# Install product app onto an iOS Simulator for Maestro.
# Usage:
#   ./studio-local/install-app-on-sim.sh [projectRoot] [udid] [appId]
# Env:
#   STUDIO_MAESTRO_INSTALL=1  force reinstall even if app already present
#   STUDIO_INSTALL_MODE=clone|expo|auto  (default auto: clone from another sim if possible, else expo run:ios)
#
# Canonical expo command (pocket-love / Expo ~57):
#   cd "$PROJECT" && npx expo run:ios --device "$UDID" --configuration Debug --no-bundler
# Fast path used when another sim already has the same bundle:
#   xcrun simctl install "$UDID" "$(xcrun simctl get_app_container "$OTHER" "$APP_ID" app)"

PROJECT=${1:-/Users/abdullah/Documents/projects/pocket-love}
UDID=${2:-812A595B-0FDA-4C3F-9346-088E6C07A489}
APP_ID=${3:-app.pocketlove.private}
MODE=${STUDIO_INSTALL_MODE:-auto}
FORCE=${STUDIO_MAESTRO_INSTALL:-0}

export PATH="/Users/abdullah/.local/share/fnm/node-versions/v24.16.0/installation/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

has_app() {
  xcrun simctl get_app_container "$1" "$APP_ID" data >/dev/null 2>&1
}

if [[ "$FORCE" != "1" ]] && has_app "$UDID"; then
  echo "SKIP: $APP_ID already installed on $UDID"
  exit 0
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator >/dev/null 2>&1 || true
for i in {1..45}; do
  xcrun simctl list devices | grep "$UDID" | grep -q '(Booted)' && break
  sleep 1
done

clone_from_other() {
  local line udid app_path
  while IFS= read -r line; do
    udid=$(echo "$line" | sed -n 's/.*(\([A-F0-9-]\{36\}\)).*/\1/p')
    [[ -n "$udid" && "$udid" != "$UDID" ]] || continue
    if has_app "$udid"; then
      app_path=$(xcrun simctl get_app_container "$udid" "$APP_ID" app 2>/dev/null || true)
      if [[ -n "$app_path" && -d "$app_path" ]]; then
        echo "CLONE: installing from $udid → $UDID ($app_path)"
        xcrun simctl install "$UDID" "$app_path"
        return 0
      fi
    fi
  done < <(xcrun simctl list devices available | grep -E 'iPhone|iPad')
  return 1
}

expo_install() {
  if [[ ! -d "$PROJECT" ]]; then
    echo "ERROR: project root not found: $PROJECT" >&2
    return 1
  fi
  echo "EXPO: npx expo run:ios --device $UDID --configuration Debug --no-bundler (cwd=$PROJECT)"
  cd "$PROJECT"
  npx expo run:ios --device "$UDID" --configuration Debug --no-bundler
}

case "$MODE" in
  clone)
    clone_from_other || { echo "ERROR: no donor sim with $APP_ID"; exit 1; }
    ;;
  expo)
    expo_install
    ;;
  auto|*)
    if clone_from_other; then
      :
    else
      echo "CLONE: no donor sim; falling back to expo run:ios"
      expo_install
    fi
    ;;
esac

if has_app "$UDID"; then
  echo "OK: $APP_ID on $UDID"
  exit 0
fi
echo "ERROR: install finished but $APP_ID still missing on $UDID" >&2
exit 1
