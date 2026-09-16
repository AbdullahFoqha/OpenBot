# Design: Grok Bot autonomy parity in openbot-studio

**Date:** 2026-09-16  
**Owner:** finalizer (PO)  
**Engineer:** Studio Engineer  
**Status:** approved (Abdullah) — approach B, full P0–P2 backlog  
**Repo:** `/Users/abdullah/Developer/openbot-studio`

## 1. Intent

Make openbot-studio a **Grok Bot–class autonomous desktop agent runtime**:

- Work on **any** registered project (not only pocket-love)
- Drive **Mac + browser** without babysitting
- **Spawn new bots** with specific roles at runtime
- Long stretches of useful work with **zero dashboard tourism**

Finalizer (Grok) remains Product Owner / judgment outside this product. openbot does **not** replace finalizer.

### Cool bar (success metric)

One clear user message → bots plan, spawn/assign, execute on Mac/browser, verify with evidence, hand back — without Abdullah clicking Run Task, granting host folders mid-flight, or re-pasting the same AC.

## 2. Non-goals

- Replacing finalizer / revenue prioritization
- Metered API-key coding (keep Claude control-model shim `:3013` + Cursor CLI via `studio_run_task`)
- Building a second Cursor IDE UI
- Greenfield rewrite of the OpenBot server (approach C rejected)

## 3. Approach (locked)

**B — Parity primitives inside openbot** on today’s Lead + `studio_run_task` + admission spine.

Static kit bots (`~/.openbot-team/tenant/agents.yaml`) stay. Dynamic bots overlay from DB + local config.

## 4. Grok capability → openbot backlog

### P0 — Autonomy spine
| ID | Feature | Grok analog |
|----|---------|-------------|
| P0.1 | `studio_spawn_bot` + UI list + chatable | CreateAgent |
| P0.2 | Multi-project register/select any git root | multi-machine/project work |
| P0.3 | Mac desktop agent session (GUI click/type + shots + stop) | computerUse on user Mac |
| P0.4 | Browser agent session (persistent profile + shots) | box browser / computerUse |
| P0.5 | Unattended run contract (one message → handback) | autonomy defaults |

### P1 — Org + memory
| ID | Feature | Grok analog |
|----|---------|-------------|
| P1.1 | Bot-to-bot messaging (priority vs FYI) | SendToAgent |
| P1.2 | Channels / multi-bot rooms | CreateChannel |
| P1.3 | Durable memory per bot + shared user memory | update_state memory |
| P1.4 | Skills pack attachable to roles | skills |
| P1.5 | In-studio Verifier bot (Mac evidence only) | Ultra Verifier pattern |

### P2 — Away-from-keyboard
| ID | Feature | Grok analog |
|----|---------|-------------|
| P2.1 | Routines (cron + GitHub/Slack listeners) | routines |
| P2.2 | Background executors (parallel beyond 1/bot where safe) | Task/executor |
| P2.3 | MCP connector install/auth UX | plugins/MCP |
| P2.4 | Secret vault UI (bot-scoped) | secret-request |
| P2.5 | Cold solo ≤15m any registered project | end-to-end autonomy demo |

## 5. Current runtime facts (constraints)

- Bots today: compiled into `~/.openbot-team/tenant/agents.yaml` (JSON, ~built-in six + prompts) via generate-studio / kit.
- Coding/QA: `studio_run_task` → Cursor worktree on Mac; one primary task per `ownerBotId` (admission).
- Lead already coordinates; `message_bot` may exist for handoffs — dynamic bots must plug into the same identity space.
- Drivers unchanged: Claude shim + Cursor subscription.

## 6. P0.1 detailed design — `studio_spawn_bot`

### 6.1 User-facing behavior

1. Lead (or Abdullah via API/UI) creates a bot:
   - `id` (slug, kebab-case, unique)
   - `name`, `title`
   - `systemPrompt` (role instructions) **or** `templateRoleId` (copy from built-in/template)
   - optional `avatarSeed`
2. Bot appears in studio UI agent list / channel picker.
3. User can open a chat with the new bot; Lead can `message_bot` / assign work with `ownerBotId=<new id>` when the bot is an execution role (see 6.4).
4. Spawning does **not** require regenerating the whole tenant kit for the happy path (DB overlay). Kit regenerate remains for shipping built-ins.

### 6.2 API / tools

**Tool (Lead):** `studio_spawn_bot`

```
{
  id: string,              // required, /^[a-z][a-z0-9-]{1,63}$/
  name: string,
  title?: string,
  systemPrompt?: string,   // required unless templateRoleId
  templateRoleId?: string, // e.g. quality-engineer — copies prompt as starting point
  avatarSeed?: string
}
```

Returns: `{ botId, name, created: true }` or `{ error }`.

**HTTP (parity with dashboard):**
- `POST /api/studio/bots` — same body
- `GET /api/studio/bots` — built-ins + dynamic
- `GET /api/studio/bots/:id`
- `PATCH /api/studio/bots/:id` — name/title/prompt (dynamic only)
- `DELETE /api/studio/bots/:id` — dynamic only (never delete built-in)

### 6.3 Persistence

New table `studio_dynamic_bots` (names flexible):

| column | type | notes |
|--------|------|-------|
| id | text PK | slug |
| name | text | |
| title | text null | |
| system_prompt | text | |
| avatar_seed | text null | |
| template_role_id | text null | provenance |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| archived_at | timestamptz null | soft delete preferred |

Runtime agent catalog = **tenant built-ins ∪ dynamic rows** (dynamic wins on id collision → reject spawn instead).

Reject spawn if `id` matches a built-in (`studio-lead`, `react-native-engineer`, `quality-engineer`, `product-designer`, `product-researcher`, `technical-lead`, …).

### 6.4 Execution capability

Phase 1 (this ship): spawned bots are **chat + coordination capable** (appear in UI, receive messages, hold a system prompt).

Phase 1b (same PR if cheap, else follow-up): allow `ownerBotId=<dynamicId>` on `studio_run_task` **only if** `capabilities` includes `cursor_execute` (default **false** for safety). Default spawn = chat/role only; set `capabilities: ["cursor_execute"]` to use Cursor runner.

Document the flag clearly in tool schema.

### 6.5 UI

Minimal:
- Bots list shows dynamic bots with a “Custom” badge
- “New bot” form or Lead-spawned bots appear without refresh hacks (WS/invalidate)
- Chat thread works with CopilotKit / existing agent chat path for dynamic ids

### 6.6 Acceptance criteria (P0.1)

1. `POST /api/studio/bots` creates a row; `GET /api/studio/bots` returns it alongside built-ins.
2. Duplicate built-in id → 409.
3. Lead tool `studio_spawn_bot` available in studio-lead tool list after regenerate **or** dynamic tool registration without full kit regen (prefer server-side tools.ts registration so Lead can call immediately after server restart).
4. Prove script or manual: spawn `custom-researcher-demo`, open chat in UI (Playwright or documented curl+UI shot), send a message, get a model reply using the custom system prompt (evidence: screenshot or chat log path).
5. `DELETE` archives/removes dynamic bot; built-in delete refused.
6. Unit tests for validation + catalog merge.
7. Doc: short section in `DAY_TO_DAY_CAPABILITY.md` or new `GROK_PARITY.md` pointing at this spec.
8. Local commit; no push unless asked.
9. Idle restart studio so Lead picks up tool if needed.

### 6.7 Untested / follow-ups (explicit)

- Spawning mid-flight without restart if tools are static at boot
- Dynamic bot as `ownerBotId` for Cursor (Phase 1b)
- Avatar upload beyond seed

## 7. P0.2–P0.5 sketches (implement after P0.1)

**P0.2 Multi-project:** `studio_products` already exists — UX + API to register absolute git roots; remove pocket-love hardcodes from Maestro defaults (env overrides OK).

**P0.3 Mac desktop agent:** new runner kind `desktop_session` with screenshot evidence dir; stop endpoint; no Cursor required.

**P0.4 Browser agent:** persistent Chromium user-data-dir under studio-local; Playwright or CDP; evidence shots.

**P0.5 Unattended contract:** Lead system prompt + tool policy: when AC clear, always `studio_run_task` / spawn / verify without clarify menus (extend lead-harden).
Source of truth for Lead coding rules: `~/.openbot-team/STUDIO-LEAD-CODING.md` (tracked copy `docs/STUDIO-LEAD-CODING.md`); spliced into `tenant/agents.yaml` studio-lead `system_prompt`.

## 8. P1–P2

Implement in backlog order after P0 demos. Each gets its own AC doc when started.

## 9. Risks

- Tenant regenerate overwrites — mitigate with DB overlay, not editing agents.yaml by hand.
- Capacity model (“one primary task per bot”) — dynamic execute bots still obey admission.
- Prompt injection via spawned system prompts — treat like user content; no elevation of host tools.

## 10. Implementation order

1. **P0.1** spawn bot (this kick)  
2. P0.2 multi-project  
3. P0.4 browser agent (often higher leverage than raw Mac GUI)  
4. P0.3 Mac desktop agent  
5. P0.5 unattended contract polish  
6. P1.* then P2.*

## 11. Spec self-review

- No TBD placeholders for P0.1 AC  
- Approach B explicit; A/C rejected  
- Finalizer non-goal explicit  
- Phase 1 vs 1b for cursor_execute called out

## Implemented

- **P0.1** `studio_spawn_bot` — shipped (local). Phase 1b cursor_execute follow-up.
- **P0.2** multi-project register/select — shipped (local).
- **P0.4** browser agent session — shipped (local).
- **P0.5** unattended run contract — shipped (local).
- **P1.1** bot-to-bot messaging (priority vs FYI) — shipped (local).
- **P1.2** channels / multi-bot rooms — shipped (local).
- **P1.3** durable memory per bot + shared user — shipped (local).
- **P1.4** skills pack attachable to roles — shipped (local).
- **P1.5** in-studio Verifier bot (Mac evidence only) — shipped (local).
- **P0.3** Mac desktop agent session — shipped (local).
