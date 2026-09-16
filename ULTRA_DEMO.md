# Ultra demo (cold solo, ≤15 min)

**Prereq:** `./studio start` → http://127.0.0.1:3010 · product `/Users/abdullah/Documents/projects/pocket-love` · Claude shim `:3013` + Cursor signed in.

## A) Smoke (5–8 min) — already proven

1. New channel → **Studio Lead**.
2. Paste (clipboard, not slow typing):

> Create `src/ultra-demo-flag.ts` exporting `const ULTRA_DEMO = true` with a one-line comment. Call `studio_run_task` now (react-native-engineer). Reply with taskId first. No clarify menus, no host_* product writes. Hand back Shipped / Evidence / Untested / Next when done.

3. Pass: fresh `taskId`, worktree under Documents/projects, typecheck/tests green, draft PR, Lead handback.

## B) Stretch — Test Screen (proven 2026-09-16)

Engineer PR #25 + QA PR #26 already shipped that path. Optional re-run uses `studio-local/ui-test/u3-engineer-first-prove.mjs` (clipboard paste).

## C) Native QA (Maestro) — live on quality-engineer tasks

One-command (auto-install + dirty-sim reset + prefer Release):

```bash
STUDIO_INSTALL_MODE=release ./studio-local/run-maestro-flow.sh
# evidence: studio-local/ui-test/out/maestro/<stamp>/  (expect exit=0)
```

Prefer iPhone 17 Pro UDID in `studio-local/MAESTRO_INVENTORY.md`. Onboard flow uses `clearState: true`; studio reset is ON by default (`STUDIO_MAESTRO_RESET=1`).

Or via Lead/QE chat:

> Call studio_run_task with ownerBotId=quality-engineer and maestroFlow=".maestro/onboard.yaml". Prefer Release install (no Metro). Include typecheck/tests. Hand back with Maestro evidence path.

Proven exit=0: `20260916T055901Z` (reset+Release), `20260916T055953Z` (clearState alone).

## Fail = not ultra

- Lead asks for dashboard Run Task / clarify menus when AC is clear
- `host_*` instead of `studio_run_task`
- Studio dies mid-chat (should be fixed — PGID isolation)
- Silent no-op with no taskId
