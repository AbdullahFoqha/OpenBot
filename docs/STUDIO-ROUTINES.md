# Studio routines (P2.1)

Grok Bot routines parity for Product Studio: standing cron instructions that fire an unattended Bot turn.

## Lead tools

| Tool | Purpose |
|------|---------|
| `studio_routine_create` | Create (instruction + five-field cron; optional timezone, agentId, channelId) |
| `studio_routine_list` | List this user's routines |
| `studio_routine_pause` | Disable until resume |
| `studio_routine_resume` | Re-enable |
| `studio_routine_delete` | Remove permanently |

Defaults: `agentId=studio-lead`, `timezone=America/New_York`, channel = DM with that agent.

## HTTP (`/api/studio/routines`)

- `GET /` — list
- `POST /` — create `{ instruction, cron, timezone?, agentId?, channelId? }`
- `PUT /:id/enabled` — `{ enabled: boolean }`
- `POST /:id/pause` / `POST /:id/resume`
- `DELETE /:id`

## Constraints (OpenBot core)

- Cron only (GitHub/Slack event listeners are not in the routines table yet).
- At most every **15 minutes**.
- At most **20** enabled routines per user.
- Fire path: sweep → work queue → Bot turn in the routine's channel (same as `/api/routines`).

## Unattended Studio work

Put something like this in `instruction`:

> When this fires, call `studio_run_task` with title/goal/AC for the selected product, then poll `studio_task_status` and post a short handback in this channel.

Studio Lead already has `studio_run_task` on its tool list, so a Lead-owned routine can start Cursor work without a human in the loop.

## Untested: live cron fire

A full unattended fire (sweep advances a due `next_run_at` → work queue → Lead turn that may call `studio_run_task`) was **not** proven in P2.1. The cron floor is **15 minutes**, and there is no studio-facing forced-due / internal tick API that is safe to call in a short prove without racing the production sweep.

**Proven:** create / list / pause / resume / delete via Lead tools and `/api/studio/routines`, plus schedule validation (15m floor) via unit tests.

**Follow-up (optional):** far-future cron + SQL bump of `next_run_at` into the past + wait for one sweep tick, or a guarded admin `POST /api/studio/routines/:id/tick` that only offers a run when `OPENBOT_STUDIO_ALLOW_ROUTINE_TICK=1`.
