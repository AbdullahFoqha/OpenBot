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
