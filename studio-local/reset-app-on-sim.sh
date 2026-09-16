#!/bin/zsh
set -euo pipefail
# Reset app data on a sim so onboarding (and other first-run flows) see a clean install.
# Fast path: copy .app out, uninstall, reinstall same binary (no expo rebuild).
# Usage: ./studio-local/reset-app-on-sim.sh [udid] [appId]
# Env: STUDIO_MAESTRO_RESET=0 to no-op when called from wrappers that always invoke us.

UDID=${1:-812A595B-0FDA-4C3F-9346-088E6C07A489}
APP_ID=${2:-app.pocketlove.private}
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"

if [[ "${STUDIO_MAESTRO_RESET:-1}" == "0" ]]; then
  echo "SKIP: STUDIO_MAESTRO_RESET=0"
  exit 0
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
# Wait briefly for boot
for i in {1..30}; do
  xcrun simctl list devices | grep "$UDID" | grep -q '(Booted)' && break
  sleep 1
done

if ! xcrun simctl get_app_container "$UDID" "$APP_ID" data >/dev/null 2>&1; then
  echo "SKIP: $APP_ID not installed on $UDID (nothing to reset)"
  exit 0
fi

STASH=$(mktemp -d)/app.app
APP_SRC=$(xcrun simctl get_app_container "$UDID" "$APP_ID" app)
echo "STASH: $APP_SRC → $STASH"
cp -R "$APP_SRC" "$STASH"

xcrun simctl terminate "$UDID" "$APP_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$APP_ID"
xcrun simctl install "$UDID" "$STASH"
rm -rf "$(dirname "$STASH")"

if xcrun simctl get_app_container "$UDID" "$APP_ID" data >/dev/null 2>&1; then
  echo "OK: reinstalled clean $APP_ID on $UDID"
  exit 0
fi
echo "ERROR: reset failed — $APP_ID missing after reinstall" >&2
exit 1
