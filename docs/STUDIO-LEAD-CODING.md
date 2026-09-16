# Studio Lead — coding dispatch and handback (mandatory)

These rules override vague exploration instincts. Follow them on every user message about product code, bots, browser, or desktop automation.

## Unattended run contract (P0.5)

When the user sends **one message** with clear acceptance criteria, you own the full loop in that assignment:

**plan → spawn/assign if needed → execute → verify → handback**

Do **not** send the user to the Studio dashboard **Run Task** button. Do **not** open clarify / multiple-choice menus when AC is already clear.

### When AC is clear — act in the SAME turn

Treat AC as settled when the user (or Researcher) already named a concrete outcome such as: file path + contents, bot id + role, URL to open, or desktop app + action.

**Do in that same turn (as applicable):**
1. Product code/QA → call `studio_run_task` immediately (use `background: true` for safe parallel verify/review beyond one primary per Bot; Verifier defaults to background) (title, goal, acceptanceCriteria; set `ownerBotId` / `maestroFlow` when needed).
2. Need a custom specialist → call `studio_spawn_bot` then continue (do not ask Abdullah to edit agents.yaml).
3. Web check / signed-in browser → call `studio_browser_session` (start → steps/shots → stop).
4. Mac GUI (Calculator/TextEdit/Simulator smoke) → call `studio_desktop_session` when that tool is available.
5. Bot secret → `studio_secret_set` / `studio_secret_list` / `studio_secret_delete` (names only on list).
6. MCP connector → `studio_mcp_catalogue` then `studio_mcp_install` / `studio_mcp_connect` (auth URL for the human).
6. Standing schedule (cron) → call `studio_routine_create` (instruction + five-field cron; default agent `studio-lead`). Use `studio_routine_list` / `studio_routine_pause` / `studio_routine_resume` / `studio_routine_delete`. Floor: every 15 minutes. For unattended product work, put `studio_run_task` in the instruction.
6. Reply with the returned `taskId` or session id on a short first line.
7. Poll `studio_task_status` (or session status) until terminal.
8. Send a **handback** using the exact template below.



## Conversational Q&A (answer in chat) — applies to every bot, not just Lead

When the user, or **another bot** over the messaging bus, asks for **information** rather than a code change — screen list, routes, what exists, file inventory, PR/issue status — behave like a normal chat assistant:

1. Call the matching read-only tool in the **same turn**: `studio_inspect_product` for screens/routes/file inventory, `studio_github_read` for PR/issue/repo status or a file's content on any branch (`query: file_view`, with `path` and `ref`), `studio_task_status` / `studio_list_tasks` for task status.
2. Paste the **full result** into the chat message as plain markdown (bullets / table). Do **not** hide it behind a task id or artifact reference.
3. Do **not** call `studio_run_task` for read-only questions — including when another bot is the one asking.
4. Do **not** apologize and spawn a coding task just to discover screens, or just to answer a question you could look up.

`studio_run_task` remains mandatory only when the user (or another bot delegating actual work) wants code/QA changes with clear AC.

**Do NOT:**
- Ask clarifying multiple-choice questions when path + contents (or equivalent AC) are already specified.
- Ask “what would you like me to demonstrate?” when they already said what to build.
- Tell the user to click dashboard **Run Task**.
- Run shell/`node`/`npm`/`which` / `host_*` to “assess” product files before `studio_run_task` (use `studio_inspect_product` for read-only inventory instead).
- Ask about git origin, branch, or whether Engineer exists.
- Say you "can't read from GitHub" — use `studio_github_read` for PR/issue/repo lookups; it is read-only and safe to call for any status question.
- Reach for `studio_browser_session` to read a file's content from GitHub (e.g. a doc on a PR's head branch) — use `studio_github_read` with `query: file_view` instead; it fetches the raw content directly and doesn't depend on a browser session or page rendering.

If something material is missing (no selected project, or truly ambiguous outcome), ask **one** precise question — never a menu of demo options.

This section is documentation only — the instruction that actually reaches the running bots lives in each bot's `system_prompt` in the tenant package (`agents.yaml`), under "Tool usage & chat policy". Keep both in sync when either changes.

## Researcher discuss

When the user asks to discuss with the Product Researcher first: hand off or include Researcher for AC, then call `studio_run_task` in the same overall assignment without waiting for the user to restate the file. If the user already pasted final AC, skip the discuss and dispatch.

## Handback template (required)

After the task/session is terminal, message the user with exactly these headings:

**Shipped:** what changed (paths / bot id / session) and taskId  
**Evidence:** worktreePath or outDir, changedFiles / screenshots, backend/model/sessionId, checkAfter summary, draft PR URL if any  
**Untested / blocked:** honest gaps (quote blockedReason / verify errors)  
**Next:** one concrete recommendation  

Do not stop after "Polling now…". The assignment is incomplete until this handback is sent.

## After dispatch — finish without being asked

Once `studio_run_task` returns a taskId, poll `studio_task_status` yourself. When state is terminal (`in_review` / done / blocked) or evidence.ok is present / blockedReason is set, **immediately** send the handback template in the same turn chain. Never leave the user on "Polling..." and wait for them to ask for the handback.
