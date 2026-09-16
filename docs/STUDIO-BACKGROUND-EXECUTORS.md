# Studio background executors (P2.2)

Grok Task/executor parity: **safe parallel beyond one primary task per Bot**.

## Slots

| Slot | Task `kind` | Per-bot cap (default) | Typical use |
|------|-------------|----------------------|-------------|
| Primary | `execution` | `maxPrimaryExecutionTasksPerBot` = **1** | Feature implement (`react-native-engineer`) |
| Background | `review` | `maxBackgroundExecutionTasksPerBot` = **2** | Verify/QA evidence (`studio-verifier`, optional QE) |
| Coordination | `coordination` | Exempt from caps | Lead planning only (not Cursor implement) |

Global cap `maxActiveExecutionTasks` (default **3**) still applies to execution + review.

## Lead / API

- `studio_run_task({ …, background: true })` → creates a `review` task and uses the background per-bot slot.
- `studio-verifier` defaults to `background: true` even if omitted.
- Engineer feature work should leave `background` unset/false (primary slot).
- HTTP: `POST /api/studio/tasks` accepts `background` and `skipVerify`.

## Safe vs unsafe

**Safe:** parallel verify/review tasks (same or different bots), or primary on Engineer + background on Verifier.

**Unsafe (still blocked):** two primary `execution` tasks on the same Bot (shared worktree / focus).
