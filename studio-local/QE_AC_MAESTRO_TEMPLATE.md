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

## Same-turn behavior for `studio_run_task` (ownerBotId=quality-engineer)

1. Parse `maestro:` from acceptanceCriteria (relative paths resolve under the product project root).
2. Re-run typecheck + tests as usual.
3. Run one-command Maestro:
   ```
   /Users/abdullah/Developer/openbot-studio/studio-local/run-maestro-flow.sh <flow> [udid]
   ```
4. Attach evidence dir under `studio-local/ui-test/out/maestro/<stamp>/` (meta.txt, maestro.log, debug/, artifacts/).
5. Handback: pass only if npm checks green **and** Maestro exit 0. Exit 2 = app not installed (blocker, not product fail). Exit 1 = flow assert fail (product/UI fail).

## Do not

- Claim iOS journey pass from browser/unit tests alone when `maestro:` is present.
- Steal a sim reserved by another task; prefer iPhone 17 Pro when free and app-installed.
- Skip Maestro because "npm passed".

For Maestro without Metro: set env `STUDIO_INSTALL_MODE=release` (or ensure Release DerivedData .app exists). Prefer pocket-love flows with `launchApp: clearState: true` for first-run screens.
