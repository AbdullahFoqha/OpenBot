# Quality Engineer — Maestro AC (optional)

When acceptance criteria include a `maestro:` line, treat native UI proof as part of the assignment.

## AC shape

```
maestro: .maestro/onboard.yaml
# or absolute:
maestro: /Users/abdullah/Documents/projects/pocket-love/.maestro/payday-ineligible.yaml
```

Optional companions:
- `device: 812A595B-0FDA-4C3F-9346-088E6C07A489` (default: iPhone 17 Pro studio reserve)
- `appId: app.pocketlove.private`

## Install mode (prefer Release)

Prefer **`STUDIO_INSTALL_MODE=release`** for Maestro so the JS bundle is embedded in the app.

- Avoids Metro RedBox (`No script URL provided`) on Debug installs.
- `install-app-on-sim.sh` / `run-maestro-flow.sh` auto-prefer newest `DerivedData/*/Release-iphonesimulator/PocketLove.app` when mode is `auto` or `release`.
- Force refresh: `STUDIO_MAESTRO_INSTALL=1 STUDIO_INSTALL_MODE=release`.
- Canonical rebuild: `npx expo run:ios --device <udid> --configuration Release --no-bundler`.

First-run flows (onboard): product YAML should use `launchApp: clearState: true`.

## Same-turn behavior for `studio_run_task` (ownerBotId=quality-engineer)

1. Parse `maestro:` from acceptanceCriteria (relative paths resolve under the product project root).
2. Re-run typecheck + tests as usual.
3. Run one-command Maestro with Release preferred:
   ```bash
   STUDIO_INSTALL_MODE=release \
     /Users/abdullah/Developer/openbot-studio/studio-local/run-maestro-flow.sh <flow> [udid]
   ```
4. Attach evidence under `studio-local/ui-test/out/maestro/<stamp>/` (`meta.txt`, `install.log`, `reset.log`, `maestro.log`, `debug/`).
5. Handback: pass only if npm checks green **and** Maestro exit 0. Exit 2 = app not installed / install failed (blocker). Exit 1 = flow assert fail (product/UI).

## Do not

- Claim iOS journey pass from browser/unit tests alone when `maestro:` is present.
- Steal a sim reserved by another task; prefer iPhone 17 Pro when free.
- Skip Maestro because "npm passed".
- Use Debug+Metro for unattended QE unless Metro is already proven up.
