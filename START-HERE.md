# OpenBot Product Studio — start here

Local, single-user setup on this Mac. Not pushed to the public fork (see `.git/info/exclude`).

## Launcher

**`/Users/abdullah/Developer/openbot-studio/Start-Studio.command`** — double-click it in Finder.
It works even if nothing is running yet and does nothing extra if the studio is already up.

From a terminal, the same thing is `./studio start` (or the absolute path — it resolves its own
location, so your shell's current directory never matters):

    /Users/abdullah/Developer/openbot-studio/studio start

**App URL: http://127.0.0.1:3010**

## Everyday steps

| I want to... | Command / where | What it does |
| --- | --- | --- |
| Start the studio | Double-click `Start-Studio.command`, or `./studio start` | Starts only what isn't already running (Postgres, control model, server, app), waits for real health checks, opens the app. Running it twice never creates duplicate processes. |
| See what's running | `./studio status` | Postgres/control-model/server/app up or down, and how many studio tasks are active right now. |
| Check setup without spending the model | `./studio check`, or **Check Setup** in the app | Server, database, Cursor CLI login, selected project, queue state. Runs no inference. |
| Select a project | Studio page → **Project** row → paste an absolute path | Verified on this machine (must exist, must be a git repo) before it's saved. Currently a pasted path, not a native folder picker — see Known gaps. |
| Prove coding actually works | Studio page → **Run Coding Test** | Real Cursor CLI run in a disposable fixture, independently re-checked by the server (not by trusting the agent's own report). Shows the diff and before/after check output. |
| Give the team a task | Studio page → **Run a task** → title, goal, acceptance criteria → **Run Task** | Creates the task's own branch and git worktree in your selected project, dispatches it to the Engineer through the same admission/reservation path the coding test uses. Double-clicking Run Task does not create a second task. |
| Watch progress | Studio page → **Active work** | State, owner, blocker and evidence (diff, changed files, session id) per task, refreshed automatically while anything is active. |
| Stop one running task | Active work row → **Stop** | Sends SIGTERM to that task's Cursor process group and releases its reservation. Its worktree and any evidence already written are kept — nothing is deleted. |
| Pause new work (not what's running) | Studio page → **Queue** switch | Stops new tasks from being assigned; anything already running keeps running. Persisted, so a server restart does not silently un-pause it. |
| Start a fresh conversation with a coworker | Sidebar → **+** → pick a coworker (or `/channel/new`) | Existing OpenBot feature, not new: a new channel/thread with the same Bots, roles and permissions. Older chats stay in the sidebar. |
| Clear the activity list without losing history | Studio page → **Clear activity** | Hides finished rows from this screen only. Reload the page and they're back — nothing durable is deleted. |
| Stop the studio | `./studio stop` | Refuses and tells you the active task count if anything is running; `./studio stop --force` stops anyway (tasks are interrupted, not silently killed — their worktrees and evidence are kept). Postgres is left running; `./studio stop --all-services` also stops it. |
| Restart | `./studio restart` | Same active-work guard as stop, then start. Your selected project and task history are read back from Postgres, not replayed from a chat transcript. |

## What is verified vs. blocked vs. untested

**Verified live, this session, through the actual HTTP API** (not a standalone script):

- Server, database, and Cursor CLI login all report real status via `/api/studio/setup`.
- Project selection resolves and verifies an absolute path against a real git repo
  (`/Users/abdullah/Documents/projects/pocket-love` — the prompt's own note about a `poket-love`
  vs `pocket-love` mixup was checked; `pocket-love` is the real, correct directory).
- **Run Coding Test**, twice: a disposable fixture with a known bug, dispatched to the real Cursor
  CLI (`cursor-grok-4.6-xhigh`, reporting as "Cursor Grok 4.6 Extra High" with a real session id),
  and independently re-checked by the server after the run — `checkBefore` failing,
  `checkAfter` passing, on the same bytes.
- **Run Task** against the real, selected pocket-love project, twice: created its own branch and
  git worktree next to the checkout, ran the real worker, and captured a correct diff — including
  a bug this build fixed, where a brand-new file the worker created was invisible to plain
  `git diff` and read as "no changes" until the diff routine staged first.
- **Stop Task**: interrupted a real in-flight run, released its reservation, preserved its
  worktree.
- **Pause/Resume Queue**: paused, confirmed a new task is refused with a clear message, resumed.
  Persisted in Postgres, not in memory.
- **Duplicate/One-primary-task-per-bot guard**: a second submission while the Engineer already
  holds a task is refused with a clear 409, not silently queued or duplicated.
- The launcher: `start` is idempotent (verified no duplicate processes after calling it twice),
  `stop` refuses while a task is active and requires `--force`, `status` and `check` reflect real
  state.
- Full test suite (2629/2631, `bun run typecheck` clean on app/server/worker, `biome lint
  --error-on-warnings` clean on the changed files) after this work. The 2 failing tests predate
  this session (an unrelated, already-in-progress change to `server/src/copilot.ts`) and are not
  something this work touched or introduced.
- All test worktrees/branches created during this verification were removed from pocket-love
  afterward; your existing AO worktrees and sessions for pocket-love/poket-love were not touched.

**Blocked or genuinely untested:**

- **Continue Task is a partial implementation.** There is no formal "resume a suspended
  reservation" operation in `admission.ts` today (only `claim`, `reclaim` on an expired lease,
  `suspend`, and `release` exist) — and nothing in this build calls `suspend` at all, since Stop
  always releases rather than pausing-with-checkpoint. The `/continue` route releases the
  reservation using the fence and owner read fresh from its own database row and re-claims, which
  is safe for one Mac with no second worker racing it, but is not the fencing guarantee
  `admission.ts` documents for a genuinely concurrent worker. It has not been exercised end to end
  (only its 409 "already running" guard was).
- **Run Task does not open a pull request.** `server/src/studio/delivery.ts` (P5) owns that state
  machine and is not wired to the dashboard's Run Task route yet. A task's branch and worktree are
  left in place next to your checkout for you to review and push by hand.
- **No native folder picker.** A browser cannot hand a page a real filesystem path from a picker;
  that needs the desktop (Tauri) shell in `desktop/`, which this pass did not touch. The dialog
  takes a pasted absolute path instead, verified against the real filesystem and git root before
  saving.
- **The manager does not decide to dispatch Cursor from a chat conversation.** Run Task and Run
  Coding Test are deterministic dashboard actions that go through the real admission, task-store
  and Cursor-adapter modules — the same modules a chat-driven delegation would use — but no LLM
  turn currently picks "hand this to the Engineer" on its own. `server/src/index.ts` never called
  the Cursor adapter before this work; wiring an actual chat-triggered delegation into P1's
  remote-bot callback path is future work, not done here.
- **Six leftover test task rows remain in the studio's real database** (`studio_tasks` /
  `studio_evidence`, product id `studio-local`) from this session's live verification. Deleting
  them was blocked by this environment's own safety classifier (mass-delete guard) rather than by
  anything about the data; they're harmless (no automatic queue picks up "ready" rows today) and
  will just show as old rows in Active Work until you clear them — ask me, or run a `delete from
  studio_tasks where product_id = 'studio-local'` against `postgres://openbot@127.0.0.1:5433/openbot_studio`
  yourself.
- Cursor usage could exhaust again mid-session, the same way the setup log recorded before; the
  setup panel's "Cursor CLI login" check only confirms login, not remaining quota — a coding test
  or task can still fail on a real usage limit, and the failure is surfaced as the blocker text
  rather than hidden.

## Known limitations worth deciding on next

1. Wire `server/src/studio/delivery.ts` into Run Task so a completed task opens a draft PR instead
   of leaving a bare branch/worktree.
2. Give `admission.ts` a real `resume` operation (distinct from `reclaim`, which is for a lease
   that already expired) so Continue Task is exact rather than "release and re-claim."
3. If you want the Studio Lead to be the one deciding to hand work to the Engineer from a chat
   message, that's a second integration on top of P1/P4b, not something this dashboard needed to
   reach the priority flow (Start → Select Project → Run Coding Test → Submit Task).
