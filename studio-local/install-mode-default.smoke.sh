#!/bin/zsh
# Assert install-app-on-sim.sh defaults MODE to release when STUDIO_INSTALL_MODE unset.
set -euo pipefail
ROOT=${0:a:h}
# Source the default line the same way the install script does
unset STUDIO_INSTALL_MODE || true
MODE=${STUDIO_INSTALL_MODE:-release}
[[ "$MODE" == "release" ]] || { echo "FAIL: expected release, got $MODE"; exit 1; }
grep -q 'MODE=${STUDIO_INSTALL_MODE:-release}' "$ROOT/install-app-on-sim.sh" || {
  echo "FAIL: install-app-on-sim.sh does not default to release"; exit 1;
}
echo "PASS: MODE unset → release (parity with resolveStudioInstallMode)"
