# Ultra demo (cold solo, ≤15 min)

**Prereq (≤2 min):** `./studio start` → http://127.0.0.1:3010 · selected product `/Users/abdullah/Documents/projects/pocket-love` · Claude shim `:3013` + Cursor signed in · `:3012` health 200.

Timer starts after prereq.

## P2.5 prove record (cold solo ≤15m)

Timed unattended coding path on selected product `pocket-love` (same dispatcher as Lead `studio_run_task`).

| Field | Value |
|-------|-------|
| Script | `studio-local/ui-test/p25-cold-solo-prove.mjs` |
| Result | `studio-local/ui-test/out/p25-cold-solo-result.json` |
| Task | `task-826a3ad2-a47b-481b-b632-45f81eaaff6d` |
| Wall clock | **40s** (limit 900s) |
| State | `in_review`, `evidence.ok=true` |
| Changed | `src/ultra-demo-flag.ts` |
| Model | requested `cursor-grok-4.6-high` → reported `Cursor Grok 4.6 High` |
| Worktree | `/Users/abdullah/Documents/projects/p25-cold-solo-591087-aaff6d.studio-worktree` |
| Checks | `npm run typecheck` exit 0; tests exit 0 |

Pass criteria met: clear AC → taskId → Mac Cursor work → verify → terminal evidence within 15 minutes.


## A) Smoke (5–8 min) — coding path

1. New channel → **Studio Lead**.
2. Paste (clipboard):

> Create `src/ultra-demo-flag.ts` exporting `const ULTRA_DEMO = true` with a one-line comment. Call `studio_run_task` now (react-native-engineer). Reply with taskId first. No clarify menus, no host_* product writes. Hand back Shipped / Evidence / Untested / Next when done.

3. Pass: fresh `taskId`, worktree under Documents/projects, typecheck/tests green, draft PR, Lead handback.

## B) Stretch — Test Screen (optional)

Engineer PR #25 + QA path already proven. Re-run: `studio-local/ui-test/u3-engineer-first-prove.mjs` (clipboard paste). Skip if short on time.

## C) Native QA (Maestro) — live QE path (≤5 min wall if Release app warm)

### Preferred: same dispatcher as Lead tools (HTTP prove)

```bash
cd /Users/abdullah/Developer/openbot-studio
node studio-local/ui-test/qe-maestro-e2e.mjs
```

Posts to `POST /api/studio/tasks` with:

- `ownerBotId=quality-engineer`
- `maestroFlow=.maestro/onboard.yaml`
- `deviceUdid=812A595B-0FDA-4C3F-9346-088E6C07A489` (iPhone 17 Pro)
- AC includes `maestro:` / `device:` lines

Pass: `evidence.ok=true`, npm typecheck+test exit 0, **`maestro.exitCode=0`**.

Evidence:

- Result JSON: `studio-local/ui-test/out/qe-maestro-e2e-result.json`
- Maestro stamp (worktree): `…/<task-worktree>/studio-local/ui-test/out/maestro/<stamp>/` (`meta.txt`, `install.log`, `reset.log`, `maestro.log`, `debug/`)

Proven live: task `task-95d84d7e-1731-4ce8-afb4-d985fab64578` → stamp `2026-09-16T1425Z`.

### Or via Lead/QE chat

> Call `studio_run_task` with `ownerBotId=quality-engineer`, `maestroFlow=".maestro/onboard.yaml"`, `deviceUdid=812A595B-0FDA-4C3F-9346-088E6C07A489`. Prefer Release install (no Metro). Include typecheck/tests. Hand back with Maestro evidence path.

### Shell-only (no studio task)

```bash
STUDIO_INSTALL_MODE=release ./studio-local/run-maestro-flow.sh
# defaults: preferred UDID, dirty-sim reset ON, clearState in onboard.yaml
# evidence: studio-local/ui-test/out/maestro/<stamp>/
```

Defaults: `STUDIO_INSTALL_MODE=release` (TS + shell), `STUDIO_MAESTRO_RESET=1`, onboard `launchApp: clearState: true`.

## Fail = not ultra

- Lead asks for dashboard Run Task / clarify menus when AC is clear
- (P0.5) Lead violates unattended contract in `docs/STUDIO-LEAD-CODING.md`
- `host_*` instead of `studio_run_task`
- Studio dies mid-chat (PGID isolation should prevent)
- Silent no-op with no taskId
- QE Maestro blocked as “no changes” or “no native worker” (fixed: verify-only + in-process nativeWorker)
