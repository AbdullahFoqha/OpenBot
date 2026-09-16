# Maestro smoke (pocket-love)

**Binary:** `~/.maestro/bin/maestro` (v2.10.0)  
**Preferred UDID:** iPhone 17 Pro `812A595B-0FDA-4C3F-9346-088E6C07A489`  
**App ID:** `app.pocketlove.private`

## Dirty-sim + Release (required for reliable onboard)

Preferred fix: pocket-love `.maestro/onboard.yaml` uses `launchApp: clearState: true` (commit in product repo).

Onboarding is `!ledger.hasHousehold()` (SQLite + SecureStore). A warm Debug install fails for two reasons:
1. **Already onboarded** → `onboarding.startingAmount` missing  
2. **Debug without Metro** → RedBox `No script URL provided`

### Fix A — wipe data (fast)
```bash
./studio-local/reset-app-on-sim.sh 812A595B-0FDA-4C3F-9346-088E6C07A489
# stash .app → uninstall → reinstall same binary
```
Default ON in `run-maestro-flow.sh`. Skip: `STUDIO_MAESTRO_RESET=0`.

### Fix B — Release binary (embeds JS, no Metro)
```bash
STUDIO_INSTALL_MODE=release STUDIO_MAESTRO_INSTALL=1 \
  ./studio-local/install-app-on-sim.sh
# or: npx expo run:ios --device 812A595B-… --configuration Release --no-bundler
```
`install-app-on-sim.sh` auto prefers newest `DerivedData/*/Release-iphonesimulator/PocketLove.app`.

### Fix C — Maestro clearState
`.maestro/onboard.yaml` uses `launchApp: clearState: true`.

## One-command smoke (proved 2026-09-16)

```bash
cd /Users/abdullah/Developer/openbot-studio
STUDIO_MAESTRO_INSTALL=1 STUDIO_INSTALL_MODE=release \
  ./studio-local/run-maestro-flow.sh \
  /Users/abdullah/Documents/projects/pocket-love/.maestro/onboard.yaml \
  812A595B-0FDA-4C3F-9346-088E6C07A489
```

**PASS evidence:** `studio-local/ui-test/out/maestro/20260916T055901Z/` — exit 0  
(assert startingAmount → tap save → home.everydayBalance + home.addSpending)

QE AC: prefer `STUDIO_INSTALL_MODE=release` — see `studio-local/QE_AC_MAESTRO_TEMPLATE.md`.

Shell parity: `install-app-on-sim.sh` defaults `STUDIO_INSTALL_MODE` to **release** (same as TS `resolveStudioInstallMode`); use `auto` explicitly for clone/expo fallbacks.

Env knobs: `STUDIO_MAESTRO_RESET=0` · `STUDIO_MAESTRO_INSTALL=1` · `STUDIO_INSTALL_MODE=release|clone|expo|auto`


## Flow matrix (Release + reset, preferred UDID)

Recipe:

```bash
STUDIO_INSTALL_MODE=release STUDIO_MAESTRO_RESET=1 \
  ./studio-local/run-maestro-flow.sh \
  /Users/abdullah/Documents/projects/pocket-love/.maestro/<flow>.yaml \
  812A595B-0FDA-4C3F-9346-088E6C07A489
```

| Flow | Status | Evidence stamp | Notes |
|------|--------|----------------|-------|
| `onboard.yaml` | **PASS** | `20260916T055901Z` (also QE E2E / Lead-tool) | `clearState` + Release |
| `expense.yaml` | **PASS** | `20260916T144031Z` | clearState + short onboard prefix |
| `payday-ineligible.yaml` | **PASS** | `20260916T144108Z` | clearState + short onboard; no collectPayday |
| `payday.yaml` | needs seed | — | Requires eligible `home.collectPayday` after onboard |
| `expense-media.yaml` | **Release gap** | `20260916T144143Z` (exit 1) | Fails at `debug.attachFakeReceipt` — those controls are `__DEV__`-only; Release binary strips them. Use a Debug/dev-client install for this flow; do not expect Release smoke PASS. |

