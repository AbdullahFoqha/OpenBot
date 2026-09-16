# Day-to-day capability bar (openbot-studio)

**Owner:** finalizer  
**Updated:** 2026-09-16  
**Audience:** Abdullah’s daily React Native shipping loop

## North star

Ask Lead in chat → bots drive **Mac + browser** without babysitting → Engineer ships via Cursor → QA proves with **unit/typecheck + Maestro on a reserved sim** → clear handback with evidence. Feels seamless: no dashboard tourism, no host-folder walls, no “install Maestro yourself” surprises mid-task.

## Must-work loops

| Loop | What “done” means | Status |
|------|-------------------|--------|
| Chat → `studio_run_task` → draft PR | taskId + green typecheck/test + PR URL | **Working** (Test Screen PR #25) |
| Lead handback | Shipped / Evidence / Untested / Next | **Working** |
| Designer Penpot | MCP tools write/export frames | **Working** |
| Stop Task | leaves terminal state, frees bot slot | **Working** (`markInterrupted`) |
| Studio stays up mid-chat | :3012/:3010/:3013 survive Lead/Playwright | **Hardened** — PGID isolation live (prove PASS 2026-09-16) |
| QA independent verify | quality-engineer task + evidence | **Working** (task-6e63017c / PR #25) |
| Maestro native journey | reserved sim + YAML + screenshot/video evidence | **Working** — QE maestroFlow + auto-install (PR #2 live); evidence includes install.log |
| Browser automation for studio itself | Playwright proves / Lead paste | **Working** (with clipboard paste) |
| Mac GUI for Xcode/sim | bot can boot sim + install app without Abdullah clicking | **Mostly** — boot+install scripts live; full expo build still slow path |

## Day-to-day recipes (target UX)

1. **Feature slice** — paste AC to Lead → Engineer PR → QA typecheck/tests → optional Maestro flow named in AC.
2. **Bugfix** — Lead → Engineer → QA re-run failing Maestro YAML + unit tests.
3. **Design check** — Designer Penpot → Engineer implements → QA Maestro asserts testIDs.
4. **Demo** — `ULTRA_DEMO.md` smoke (tiny flag) then stretch Test Screen / Maestro.

## Next build order

1. ~~Install + pin Maestro CLI~~ — done (2.10.0, PATH).
2. ~~One-command boot + maestro + evidence~~ — `run-maestro-flow.sh` (+ auto-install + dirty-sim reset).
3. ~~QE `maestro:` AC template~~ — `QE_AC_MAESTRO_TEMPLATE.md`; prefer Release / clearState.
4. ~~Silent server death~~ — PGID isolation `0f6e682` live after idle restart.
5. ~~Dirty-sim onboard~~ — `0807827` exit=0 evidence `20260916T055901Z`.
6. ~~Default `STUDIO_INSTALL_MODE=release`~~ — TS `2395912` + shell `bd195c8` (JSDoc `53fd22d`); studio on `53fd22d`.
7. ~~Cold solo demo ≤15 min~~ — `ULTRA_DEMO.md` matches live QE E2E (`qe-maestro-e2e.mjs` / maestroFlow + Release defaults); proven task-95d84d7e…
8. Optional: push OpenBot draft PRs #1/#2 when ready for review.
9. ~~Studio worktree prune~~ — `./studio prune-worktrees` (dry-run; `--apply` removes terminal/orphan `*.studio-worktree` older than N hours; never `in_progress`).

## Constraints (unchanged)

- Drivers: Claude control-model shim + Cursor CLI via `studio_run_task`.
- No metered API keys; no `host_*` for product coding.
- Grok helpers: finalizer + Studio Engineer (+ Ultra Verifier for evidence checks).

Shell path: `run-maestro-flow.sh` also invokes `install-app-on-sim.sh` when the app is missing (or `STUDIO_MAESTRO_INSTALL=1`).

Dirty-sim (2026-09-16): `reset-app-on-sim.sh` + `STUDIO_MAESTRO_RESET=1` (default) + onboard `clearState: true`; prefer Release install for Maestro (embeds JS). Prove exit=0 `20260916T055901Z`. Studio restarted on `0807827`.

Lead-tool Maestro (2026-09-16): Verifier PASS task-32149d89 via studio-lead chat (`4a0fb65`); HTTP E2E PASS task-95d84d7e. Both paths green.

Maestro flow matrix (2026-09-16): Release+reset — onboard/expense/payday-ineligible PASS; **payday Release seed** via `studio-local/maestro/payday-release-seed.yaml` (toggle OFF includes-allowance); expense-media still Release/__DEV__ gap. See studio-local/maestro-smoke.md.

Worktree hygiene (2026-09-16): `./studio prune-worktrees` dry-run lists; `--apply --older-than 2` removes terminal-task worktrees under Documents/projects.
Auto-prune on complete (2026-09-16): runner + markInterrupted call `pruneTaskWorktree` when terminal; `STUDIO_PRUNE_ON_COMPLETE=1` default (set `0` to keep worktrees).

P0.1 studio_spawn_bot (2026-09-16): Lead tool + `POST /api/studio/bots` creates dynamic chat bots (`studio_dynamic_bots` ∪ `agents`). Custom badge in UI. Phase 1b `cursor_execute` / ownerBotId=dynamic still follow-up. Spec: GROK_BOT_AUTONOMY_PARITY.md §6.

P0.2 multi-project (2026-09-16): register/list/select via `/api/studio/products`; `studio_run_task` uses selected product path. UI lists products with Select. Maestro app id via `STUDIO_APP_ID` env (udid still preferred default).

P0.4 browser agent (2026-09-16): persistent Chromium profile at `studio-local/browser-profile/`; `POST /api/studio/browser/session/start|stop`, `GET /api/studio/browser/session`; Lead tool `studio_browser_session`. Screenshots under `studio-local/ui-test/out/browser/<stamp>/`. Prove: `studio-local/ui-test/browser-session-prove.mjs`.
