/**
 * Bot-callable Studio tools: start Cursor CLI coding work the same way the dashboard Run Task does.
 *
 * Lead (and other bots) must not invent host-folder writes or Claude Allow prompts for project
 * coding. They call studio_run_task, which admits work onto react-native-engineer and runs
 * cursor-agent on the Cursor subscription.
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
      "What the Cursor Engineer must do in the selected project (files, behavior, PR expectations).",
    ),
  acceptanceCriteria: z
    .string()
    .optional()
    .describe("How to know the task succeeded. Prefer concrete file and PR checks."),
  idempotencyKey: z
    .string()
    .optional()
    .describe("Optional key so a retried call does not start a second identical task."),
});

const taskIdParams = z.object({
  taskId: z.string().min(1).describe("Studio task id, e.g. task-…"),
});

export function studioTools(options: {
  dispatcher: StudioDispatcher;
  database: Database;
  taskStore: TaskStore;
  /** When set, only these bot ids receive the tools. Absent = all bots in this deployment. */
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
          "Start autonomous coding on the selected Studio project via the Cursor Engineer (cursor-agent CLI on the Cursor subscription). Use this to create/edit files, open a feature branch, and draft a PR. Do NOT use host_write_file or claim a Claude Code Allow prompt is required. Returns a taskId to poll with studio_task_status.",
        parameters: runTaskParams,
        execute: async (args) => {
          const parsed = runTaskParams.safeParse(args ?? {});
          if (!parsed.success) {
            return `${REFUSAL_MARKER} title and goal are required.`;
          }
          const result = await dispatcher.submit({
            title: parsed.data.title,
            goal: parsed.data.goal,
            acceptanceCriteria: parsed.data.acceptanceCriteria,
            idempotencyKey: parsed.data.idempotencyKey,
          });
          if (!result.ok) {
            return `${REFUSAL_MARKER} ${result.error}`;
          }
          return JSON.stringify({
            taskId: result.taskId,
            deduplicated: result.deduplicated === true,
            ownerBotId: "react-native-engineer",
            backend: "cursor-agent (Cursor subscription)",
            note: "Coding is running asynchronously. Poll studio_task_status with this taskId. Tell the person the task id; do not ask them for git origin or branch — Studio already has the selected project.",
          });
        },
      },
      {
        name: "studio_task_status",
        ref: "studio/task_status",
        description:
          "Read one Studio task's state, blocker, evidence (changed files), and draft PR URL if any.",
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
                }
              : null,
            pullRequest: pr?.number && pr.url
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
