# Install pocket-love onto preferred Maestro sim

**Preferred UDID:** `812A595B-0FDA-4C3F-9346-088E6C07A489`  
**App ID:** `app.pocketlove.private`

## Prefer Release for Maestro

Debug builds need Metro (`No script URL` RedBox). Release embeds the JS bundle.

```bash
./studio-local/install-app-on-sim.sh   # auto: Release DerivedData → clone → expo Release
STUDIO_INSTALL_MODE=release STUDIO_MAESTRO_INSTALL=1 ./studio-local/install-app-on-sim.sh
```

Canonical expo:
```bash
cd /Users/abdullah/Documents/projects/pocket-love
npx expo run:ios --device 812A595B-0FDA-4C3F-9346-088E6C07A489 --configuration Release --no-bundler
```

Dirty-sim wipe (after install): `./studio-local/reset-app-on-sim.sh`
