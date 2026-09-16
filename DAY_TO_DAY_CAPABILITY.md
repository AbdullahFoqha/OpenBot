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
2. ~~One-command boot + maestro + evidence~~ — `studio-local/run-maestro-flow.sh` → `ui-test/out/maestro/`.
3. QE AC template for `maestro:` — `STUDIO-QE-MAESTRO.md` / `studio-local/QE_AC_MAESTRO_TEMPLATE.md` (runner auto-call still open).
4. Silent server death — root cause + fix `0f6e682`; **apply on idle restart** (hold while cursor-agent).
5. Solo demo script Abdullah can run cold in ≤15 min.

## Constraints (unchanged)

- Drivers: Claude control-model shim + Cursor CLI via `studio_run_task`.
- No metered API keys; no `host_*` for product coding.
- Grok helpers: finalizer + Studio Engineer (+ Ultra Verifier for evidence checks).

Shell path: `run-maestro-flow.sh` also invokes `install-app-on-sim.sh` when the app is missing (or `STUDIO_MAESTRO_INSTALL=1`).
