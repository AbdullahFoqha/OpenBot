# Ultra scenario — Product Studio (openbot-studio)

**Owner:** finalizer (Product Owner)  
**Engineer:** Studio Engineer  
**Updated:** 2026-09-16  
**Machine:** Abdullahs-MBP · `/Users/abdullah/Developer/openbot-studio`

## Product bar (Abdullah)

1. **Mac drive/access** — bots work on Abdullah’s Mac (files, worktrees, tools), not only the Linux box.
2. **Absolute autonomy** — once a task is accepted, run end-to-end without babysitting (no host-folder permission walls, no “please click Run Task”).
3. **Clear handback** — return to Abdullah with what shipped, evidence paths/URLs, what’s untested, and the next recommendation (or an honest blocker).
4. **Basic shim** — Studio Lead / specialists chat through the local Claude control-model shim (`:3013`), Claude OAuth — not metered API keys.
5. **Drivers** — Claude CLI (control/chat/handoffs) + Cursor CLI (`cursor-agent` via `studio_run_task`) do the real work.

## Happy path

1. Abdullah states a task to Studio Lead (optionally with Researcher in the discuss).
2. Lead + Researcher lock AC; Lead assigns specialists (visible handoffs into each bot’s 1:1).
3. Coding/QA: `studio_run_task` → Cursor CLI on a Mac worktree → verify → draft PR when checks pass.
4. Lead reports back clearly with evidence.

## Already verified

- Dashboard Run Task / Coding Test / Stop / Queue
- `studio_run_task` shares `dispatch.ts` with dashboard
- Visible specialist handoffs; Cursor subscription coding → draft PRs on pocket-love
- Penpot MCP wired for Designer — Abdullah confirmed Test Screen prove 2026-09-16
- Stop Task settles `in_progress`→`in_review` via `markInterrupted` (commit f855269)
- `./studio start` health-heals stale pid/port when /health is dead
- Test Screen Engineer path: task-b91bba7e → PR #25 (paste-based Lead prove; typecheck+55 tests green)

## Gaps to close (priority)

| # | Gap | Why |
|---|-----|-----|
| U0 | Studio process survival | **Verified** KeepAlive + health-heal + PGID isolation (0f6e682 live; PGIDs ≠ keepalive) |
| U1 | Clear handback UX | **Verified** lead-harden (task-4a08767b / PR #24) |
| U2 | Designer Penpot prove | **Verified** 2026-09-16 |
| U3 | TL → Engineer → QA | **Verified** Eng #25 + QA #26 (tasks b91bba7e / 6e63017c) |
| U4 | Native QA autonomy | **Verified tooling** — maestroFlow on QE studio_run_task (OpenBot PR #1 / local merge); app-install still manual |

## Constraints

- Sole Grok assistants for this work: finalizer + Studio Engineer (no specialist fan-out).
- Never restart server mid `cursor-agent` run.
- Product coding via `studio_run_task` only — not `host_*` folders.
- Claude OAuth + Cursor subscription — never API keys.

## Canonical demo

See `ULTRA_DEMO.md`.

## U3 prove notes (2026-09-16)
- Do **not** keyboard.type long prompts in Playwright — Lead saw truncated AC and asked to clarify. Use **pbcopy + Meta+V** (see `studio-local/ui-test/u3-engineer-first-prove.mjs`).
- Prove path is **Engineer-first** (lead-harden twin), then QA as a second `studio_run_task`.
- Ignore historical taskIds in channel body when scoring pass/fail.

## Day-to-day bar

See `DAY_TO_DAY_CAPABILITY.md` for RN/QA/Maestro/Mac-browser north star beyond ultra proves.

_U4 shell note (2026-09-16): `run-maestro-flow.sh` now calls `install-app-on-sim.sh` (parity with TS `installApp`)._

_Payday Release seed (2026-09-16): `studio-local/maestro/payday-release-seed.yaml` PASS `20260916T150132Z` (toggle includes Switch OFF; no __DEV__). expense-media still Debug-only._
