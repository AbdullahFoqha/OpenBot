/**
 * Bot-callable Studio tools: start Cursor CLI work the same way the dashboard Run Task does.
 *
 * Lead must use these for product coding/QA — not host-folder writes. Implementation runs as
 * react-native-engineer; independent verify can run as quality-engineer.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { studioEvidence, studioPullRequests, studioTasks } from "../db/schema";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import type { StudioDispatcher } from "./dispatch";
import { STUDIO_PRODUCT_ID } from "./dispatch";
import type { TaskStore } from "./task-store";
import { createDynamicBot } from "./bot-catalog";
import {
  getBrowserSession,
  startBrowserSession,
  stopBrowserSession,
  type BrowserStep,
} from "./browser-session";
import {
  runDesktopActions,
  getDesktopSession,
  startDesktopSession,
  stopDesktopSession,
  type DesktopStep,
} from "./desktop-session";

const runTaskParams = z.object({
  title: z.string().min(1).describe("Short task title for the Studio queue and branch name."),
  goal: z
    .string()
    .min(1)
    .describe(
      "What the worker must do in the selected project (implement, or for QA: verify/run tests on a branch/worktree).",
    ),
  acceptanceCriteria: z
    .string()
    .optional()
    .describe("How to know the task succeeded. Prefer concrete file, test, and PR checks. For Maestro UI verification, include a line like 'maestro: .maestro/flow.yaml'."),
  idempotencyKey: z
    .string()
    .optional()
    .describe("Optional key so a retried call does not start a second identical task."),
  ownerBotId: z
    .enum(["react-native-engineer", "quality-engineer", "technical-lead"])
    .optional()
    .describe(
      "Who owns the Cursor run. Default react-native-engineer for implementation. Use quality-engineer for independent verify/QA on the local project.",
    ),
  skipVerify: z
    .boolean()
    .optional()
    .describe("Set true only to skip automatic npm test/typecheck after the worker (rare)."),
  maestroFlow: z
    .string()
    .optional()
    .describe(
      "Path to a Maestro YAML flow file (relative to project root or absolute). When set with ownerBotId=quality-engineer, runs Maestro UI tests after npm verification. Default device: iPhone 17 Pro (812A595B-0FDA-4C3F-9346-088E6C07A489).",
    ),
  deviceUdid: z
    .string()
    .optional()
    .describe("iOS Simulator UDID for Maestro tests. Defaults to studio's preferred device (iPhone 17 Pro)."),
});

const taskIdParams = z.object({
  taskId: z.string().min(1).describe("Studio task id, e.g. task-…"),
});


const spawnBotParams = z.object({
  id: z
    .string()
    .min(2)
    .describe("Kebab-case bot id slug, e.g. custom-researcher-demo. Must not collide with built-ins."),
  name: z.string().min(1).describe("Display name."),
  title: z.string().optional().describe("Short role title chip."),
  systemPrompt: z
    .string()
    .optional()
    .describe("Role instructions. Required unless templateRoleId is set."),
  templateRoleId: z
    .string()
    .optional()
    .describe("Copy systemPrompt from a built-in (e.g. product-researcher) as a starting point."),
  avatarSeed: z.string().optional(),
  capabilities: z
    .array(z.string())
    .optional()
    .describe(
      "Phase 1 chat/role only by default. Include cursor_execute only when Phase 1b is enabled; default omit.",
    ),
});

const browserSessionParams = z.object({
  action: z
    .enum(["start", "stop", "status"])
    .describe("start opens a persistent Chromium session; stop closes it; status returns the last/current session."),
  url: z
    .string()
    .optional()
    .describe("Required for start. Absolute http(s) URL to navigate first."),
  steps: z
    .array(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("wait"), ms: z.number() }),
        z.object({ action: z.literal("screenshot"), name: z.string().optional() }),
        z.object({ action: z.literal("click"), selector: z.string() }),
        z.object({ action: z.literal("type"), selector: z.string(), text: z.string() }),
      ]),
    )
    .optional()
    .describe("Optional steps after navigation. A 01-after-nav screenshot is always taken."),
  headless: z
    .boolean()
    .optional()
    .describe("Default true for unattended runs. Set false only when a visible window is needed."),
});

const desktopStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({ action: z.literal("screenshot"), name: z.string().optional() }),
  z.object({ action: z.literal("activate"), app: z.string() }),
  z.object({ action: z.literal("open"), app: z.string() }),
  z.object({ action: z.literal("type"), text: z.string(), app: z.string().optional() }),
  z.object({ action: z.literal("keystroke"), text: z.string() }),
  z.object({ action: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({
    action: z.literal("quit"),
    app: z.string(),
    saving: z.enum(["yes", "no", "ask"]).optional(),
  }),
]);

const desktopSessionParams = z.object({
  action: z
    .enum(["start", "stop", "status", "action"])
    .describe("start opens a Mac GUI session; action runs steps; stop closes; status returns last/current."),
  app: z
    .string()
    .optional()
    .describe("Optional app to open/focus on start (e.g. TextEdit, Calculator, Simulator)."),
  steps: z
    .array(desktopStepSchema)
    .optional()
    .describe("Scripted steps: wait/screenshot/activate/open/type/keystroke/click/quit."),
});

export function studioTools(options: {
  dispatcher: StudioDispatcher;
  database: Database;
  taskStore: TaskStore;
  allowedBotIds?: readonly string[];
}): (botId: string) => GrantedTool[] {
  const { dispatcher, database, taskStore, allowedBotIds } = options;

  return (botId: string) => {
    if (allowedBotIds && !allowedBotIds.includes(botId)) return [];

    const tools: GrantedTool[] = [
      {
        name: "studio_spawn_bot",
        ref: "studio/spawn_bot",
        description:
          "Create a custom Studio bot (Grok CreateAgent parity). Appears in the agents list with a Custom badge; chatable with the given systemPrompt. Phase 1 = chat/role only (not Cursor ownerBotId unless capabilities includes cursor_execute — Phase 1b). Prefer this over asking Abdullah to edit agents.yaml. Returns { botId, name, created: true }.",
        parameters: spawnBotParams,
        execute: async (args) => {
          const parsed = spawnBotParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} id and name are required (and systemPrompt or templateRoleId).`;
          }
          const result = await createDynamicBot(database, parsed.data);
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            botId: result.bot.id,
            name: result.bot.name,
            created: true,
            source: "dynamic",
            note: "Bot is chatable now. Phase 1: chat/role only unless cursor_execute capability was set (Phase 1b).",
          });
        },
      },

      {
        name: "studio_desktop_session",
        ref: "studio/desktop_session",
        description:
          "Drive the Mac GUI (not Cursor coding): open/focus an app, type/click/wait, capture screenshots under studio-local/ui-test/out/desktop/<stamp>/. Prefer TextEdit type (app scripting) when Accessibility is unavailable. Never escalates privileges; destructive OS actions are out of scope. One session at a time. Use start|action|stop|status.",
        parameters: desktopSessionParams,
        execute: async (args) => {
          const parsed = desktopSessionParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} action is required.`;
          }
          const { action } = parsed.data;
          if (action === "status") {
            return JSON.stringify({ session: getDesktopSession() });
          }
          if (action === "stop") {
            const result = await stopDesktopSession();
            return JSON.stringify({ ok: true, session: result.session });
          }
          const steps = (parsed.data.steps ?? []) as DesktopStep[];
          if (action === "start") {
            const result = await startDesktopSession({ app: parsed.data.app, steps });
            if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
            return JSON.stringify({
              ok: true,
              session: result.session,
              note: "Session stays open until studio_desktop_session stop. Screenshots under session.outDir.",
            });
          }
          const result = await runDesktopActions(steps);
          if (!result.ok) return `${REFUSAL_MARKER} ${result.error}`;
          return JSON.stringify({ ok: true, session: result.session });
        },
      },

      {
        name: "studio_browser_session",
        ref: "studio/browser_session",
        description:
          "Drive an unattended Chromium browser with a persistent profile under studio-local/browser-profile. start: navigate to url, optional steps, screenshots under studio-local/ui-test/out/browser/<stamp>/. stop: close the session. status: current/last session. Prefer this for web checks before asking for Mac GUI. One session at a time.",
        parameters: browserSessionParams,
        execute: async (args) => {
          const parsed = browserSessionParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} action is required (start needs url).`;
          }
          const { action } = parsed.data;
          if (action === "status") {
            return JSON.stringify({ session: getBrowserSession() });
          }
          if (action === "stop") {
            const result = await stopBrowserSession();
            return JSON.stringify({ ok: true, session: result.session });
          }
          if (!parsed.data.url) {
            return `${REFUSAL_MARKER} url is required to start a browser session.`;
          }
          const steps = (parsed.data.steps ?? []) as BrowserStep[];
          const result = await startBrowserSession({
            url: parsed.data.url,
            steps,
            headless: parsed.data.headless,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            ok: true,
            session: result.session,
            note: "Session stays open until studio_browser_session stop. Screenshots are under session.outDir.",
          });
        },
      },

      {
        name: "studio_run_task",
        ref: "studio/run_task",
        description:
          "REQUIRED for local product work: create/edit files in the selected project, run changes, open a feature branch/draft PR, or (ownerBotId=quality-engineer) independently verify/QA. Uses cursor-agent on the Cursor subscription in a project worktree; after implementation the studio re-runs package.json typecheck+test and only then opens a draft PR. Call immediately for project coding/QA — do NOT use host_list_folders/host_write_file or ask about Engineer/git origin. Returns taskId; poll studio_task_status (includes checkAfter).",
        parameters: runTaskParams,
        execute: async (args) => {
          const parsed = runTaskParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} title and goal are required.`;
          }
          const ownerBotId = parsed.data.ownerBotId ?? "react-native-engineer";
          const result = await dispatcher.submit({
            title: parsed.data.title,
            goal: parsed.data.goal,
            acceptanceCriteria: parsed.data.acceptanceCriteria,
            idempotencyKey: parsed.data.idempotencyKey,
            ownerBotId,
            skipVerify: parsed.data.skipVerify,
            maestroFlow: parsed.data.maestroFlow,
            deviceUdid: parsed.data.deviceUdid,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            taskId: result.taskId,
            deduplicated: result.deduplicated === true,
            ownerBotId,
            backend: "cursor-agent (Cursor subscription)",
            note: "Work runs asynchronously in a project worktree. Poll studio_task_status. Do not ask the person for git origin or branch.",
          });
        },
      },
      {
        name: "studio_task_status",
        ref: "studio/task_status",
        description:
          "Read one Studio task's state, blocker, evidence (changed files, checkAfter verify results, worktreePath), and draft PR URL if any.",
        parameters: taskIdParams,
        execute: async (args) => {
          const parsed = taskIdParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} taskId is required.`;
          }
          const task = await taskStore.read(parsed.data.taskId);
          if (!task) {
            return `${REFUSAL_MARKER} No such task.`;
          }
          const [evidence] = await database
            .select()
            .from(studioEvidence)
            .where(eq(studioEvidence.taskId, parsed.data.taskId))
            .limit(1);
          const [pr] = await database
            .select()
            .from(studioPullRequests)
            .where(eq(studioPullRequests.taskId, parsed.data.taskId))
            .limit(1);
          return JSON.stringify({
            id: task.id,
            title: task.title,
            state: task.state,
            goal: task.goal,
            blockedReason: task.blockedReason,
            ownerBotId: task.ownerBotId,
            running: dispatcher.inFlight.has(task.id),
            evidence: evidence
              ? {
                  ok: evidence.ok,
                  changedFiles: evidence.changedFiles,
                  blocker: evidence.blocker,
                  backend: evidence.backend,
                  reportedModel: evidence.reportedModel,
                  checkAfter: evidence.checkAfter,
                  worktreePath: evidence.worktreePath,
                  maestro: evidence.maestro ?? null,
                }
              : null,
            pullRequest:
              pr?.number && pr.url
                ? {
                    url: pr.url,
                    number: pr.number,
                    draft: pr.draft,
                    headBranch: pr.headBranch,
                    baseBranch: pr.baseBranch,
                  }
                : null,
          });
        },
      },
      {
        name: "studio_list_tasks",
        ref: "studio/list_tasks",
        description:
          "List recent Studio tasks for the selected product (id, title, state, running).",
        parameters: z.object({}),
        execute: async () => {
          const rows = await database
            .select({
              id: studioTasks.id,
              title: studioTasks.title,
              state: studioTasks.state,
              ownerBotId: studioTasks.ownerBotId,
              updatedAt: studioTasks.updatedAt,
            })
            .from(studioTasks)
            .where(eq(studioTasks.productId, STUDIO_PRODUCT_ID))
            .orderBy(desc(studioTasks.updatedAt))
            .limit(20);
          return JSON.stringify({
            tasks: rows.map((row) => ({
              ...row,
              running: dispatcher.inFlight.has(row.id),
            })),
          });
        },
      },
    ];

    return tools;
  };
}
