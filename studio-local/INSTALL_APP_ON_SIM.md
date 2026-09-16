# Install pocket-love onto preferred Maestro sim

**Preferred UDID:** `812A595B-0FDA-4C3F-9346-088E6C07A489` (iPhone 17 Pro)  
**App ID:** `app.pocketlove.private`  
**Product:** Expo ~57 (`npx expo run:ios`)

## One-command

```bash
cd /Users/abdullah/Developer/openbot-studio
./studio-local/install-app-on-sim.sh \
  /Users/abdullah/Documents/projects/pocket-love \
  812A595B-0FDA-4C3F-9346-088E6C07A489 \
  app.pocketlove.private
```

## Exact underlying commands

1. **Skip if healthy** (unless `STUDIO_MAESTRO_INSTALL=1`):
   `xcrun simctl get_app_container <udid> app.pocketlove.private data`

2. **Fast path (auto/clone)** — same as Studio Engineer used 2026-09-16:
   ```bash
   APP=$(xcrun simctl get_app_container <donorUdid> app.pocketlove.private app)
   xcrun simctl install 812A595B-0FDA-4C3F-9346-088E6C07A489 "$APP"
   ```

3. **Full Debug build** (auto fallback / `STUDIO_INSTALL_MODE=expo`) — matches QE PL007 docs:
   ```bash
   cd /Users/abdullah/Documents/projects/pocket-love
   npx expo run:ios --device 812A595B-0FDA-4C3F-9346-088E6C07A489 --configuration Debug --no-bundler
   ```

## Maestro path

`run-maestro-flow.sh` calls the install script when the app is missing or `STUDIO_MAESTRO_INSTALL=1`. Evidence: `install.log` under `studio-local/ui-test/out/maestro/<stamp>/`.
