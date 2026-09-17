/**
 * One place that starts a Studio project task on the Cursor CLI engineer.
 *
 * Shared by the dashboard HTTP routes and by Bot tools (studio_run_task), so Lead chat and the
 * Studio UI take the same path: admit → worktree → cursor-agent on the Cursor subscription →
 * optional draft PR. Not a second coding backend and not host-folder writes.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioTasks } from "../db/schema";
import type { Admission } from "./admission";
import { CURSOR_ENGINEER_BOT_ID, runProjectTask } from "./runner";
import type { TaskStore } from "./task-store";
import type { NativeWorker } from "../native-worker/worker";
import type { BotMessaging } from "./bot-messaging";
import { getSelectedProduct } from "./products";
import { resolveProjectPath, STUDIO_PRODUCT_ID } from "./project-path";
export { resolveProjectPath, STUDIO_PRODUCT_ID } from "./project-path";

type InFlightRun = {
  controller: AbortController;
  startedAt: number;
  botId: string;
  background: boolean;
};

export type SubmitStudioTaskInput = {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  idempotencyKey?: string | null;
  /** Defaults to the Cursor Engineer. Pass quality-engineer for a verify-focused run. */
  ownerBotId?: string;
  /** When true, do not re-run package.json test/typecheck after the worker. */
  skipVerify?: boolean;
  /**
   * Path to a Maestro YAML flow file, relative to the project root or absolute.
   * When set (and ownerBotId is quality-engineer), the runner executes Maestro after npm verification.
   */
  maestroFlow?: string;
  /**
   * iOS Simulator UDID to use for Maestro. Defaults to `STUDIO_PREFERRED_IOS_UDID`.
   */
  deviceUdid?: string;
  /**
   * P2.2 — run as a background/review slot (parallel beyond 1 primary per Bot).
   * Default true for studio-verifier. Counts against maxBackgroundExecutionTasksPerBot
   * and the global maxActiveExecutionTasks, not the primary per-bot slot.
   */
  background?: boolean;
  /**
   * The Bot whose tool call created this task, if any. When set (and a bot-messaging bus is
   * wired), the requester is sent a priority message on completion or failure — mirroring the
   * handoff queue's guaranteed report-back, since otherwise this Bot only learns the outcome by
   * remembering to poll studio_task_status.
   */
  requestedByBotId?: string;
};

export type SubmitStudioTaskResult =
  | { ok: true; taskId: string; deduplicated?: boolean; background?: boolean; kind?: string }
  | { ok: false; status: 400 | 409; error: string };

export type StudioDispatcher = {
  inFlight: Map<string, InFlightRun>;
  submitted: Map<string, string>;
  submit: (input: SubmitStudioTaskInput) => Promise<SubmitStudioTaskResult>;
  abort: (taskId: string) => boolean;
};

export function createStudioDispatcher(deps: {
  database: Database;
  admission: Admission;
  taskStore: TaskStore;
  /**
   * Native worker for device reservation. Required for Maestro UI tests.
   * When absent, Maestro requests will fail with a clear error message.
   */
  nativeWorker?: NativeWorker;
  /** Lazy: the messaging bus is constructed after the dispatcher elsewhere in boot. */
  getBotMessaging?: () => BotMessaging | undefined;
  messagingActorId?: string;
}): StudioDispatcher {
  const { database, admission, taskStore, nativeWorker, getBotMessaging, messagingActorId } = deps;
  const inFlight = new Map<string, InFlightRun>();
  const submitted = new Map<string, string>();

  return {
    inFlight,
    submitted,
    abort(taskId) {
      const running = inFlight.get(taskId);
      if (!running) return false;
      running.controller.abort();
      inFlight.delete(taskId);
      return true;
    },
    async submit(input) {
      const title = input.title.trim();
      const goal = input.goal.trim();
      const acceptanceCriteria = (input.acceptanceCriteria ?? "").trim();
      const idempotencyKey = input.idempotencyKey ?? null;
      if (!title || !goal) {
        return { ok: false, status: 400, error: "A title and goal are required." };
      }

      if (idempotencyKey) {
        const existingTaskId = submitted.get(idempotencyKey);
        if (existingTaskId) {
          return { ok: true, taskId: existingTaskId, deduplicated: true };
        }
      }

      const product = await getSelectedProduct(database);
      if (!product?.localPath) {
        return {
          ok: false,
          status: 400,
          error: "Select a project before running a task.",
        };
      }
      if (product.queuePaused) {
        return {
          ok: false,
          status: 409,
          error:
            "The queue is paused. New work will not be assigned until you resume it.",
        };
      }
      const ownerBotId = input.ownerBotId?.trim() || CURSOR_ENGINEER_BOT_ID;
      const backgroundDefault =
        ownerBotId === "studio-verifier";
      const background =
        input.background === true ||
        (input.background !== false && backgroundDefault);
      const taskKind = background ? "review" : "execution";

      // Count this process's in-flight runs too — reservation rows appear only after claim(),
      // so a double-submit before claim would otherwise sneak past the per-bot cap.
      const inFlightForBot = [...inFlight.values()].filter((r) => r.botId === ownerBotId);
      if (background) {
        const bgInFlight = inFlightForBot.filter((r) => r.background).length;
        if (bgInFlight >= 2 || (await admission.backgroundSlotsFull(ownerBotId))) {
          return {
            ok: false,
            status: 409,
            error: `Bot ${ownerBotId} is at its background/review parallel cap. Wait for one to finish or use another Bot.`,
          };
        }
      } else if (
        inFlightForBot.some((r) => !r.background) ||
        (await admission.holdsPrimaryWork(ownerBotId))
      ) {
        return {
          ok: false,
          status: 409,
          error: `Bot ${ownerBotId} already has a primary task in progress. One primary per bot (use background:true for safe parallel review/verify).`,
        };
      }

      const resolved = await resolveProjectPath(product.localPath);
      if (!resolved.ok) {
        return { ok: false, status: 400, error: resolved.reason };
      }

      const taskId = `task-${randomUUID()}`;
      if (idempotencyKey) submitted.set(idempotencyKey, taskId);
      const requestedByBotId = input.requestedByBotId?.trim() || undefined;

      const notifyRequester = async (message: string) => {
        if (!requestedByBotId || requestedByBotId === ownerBotId) return;
        const botMessaging = getBotMessaging?.();
        if (!botMessaging) return;
        await botMessaging
          .send({
            fromBotId: ownerBotId,
            toBotId: requestedByBotId,
            message,
            priority: true,
            actorId: messagingActorId ?? "dev-local-user",
          })
          .catch(() => {});
      };

      await taskStore.createTask({
        id: taskId,
        productId: product.id,
        title,
        kind: taskKind,
        state: "ready",
      });
      await database
        .update(studioTasks)
        .set({ goal, acceptanceCriteria })
        .where(eq(studioTasks.id, taskId));

      const controller = new AbortController();
      inFlight.set(taskId, {
        controller,
        startedAt: Date.now(),
        botId: ownerBotId,
        background,
      });

      void runProjectTask({
        admission,
        taskStore,
        database,
        productId: product.id,
        projectPath: resolved.absolutePath,
        taskId,
        botId: ownerBotId,
        title,
        goal,
        acceptanceCriteria,
        ...(input.skipVerify ? { verifyCommands: [] } : {}),
        ...(input.maestroFlow ? { maestroFlow: input.maestroFlow } : {}),
        ...(input.deviceUdid ? { deviceUdid: input.deviceUdid } : {}),
        ...(nativeWorker ? { nativeWorker } : {}),
      })
        .then(async (outcome) => {
          const lines = [
            outcome.ok
              ? `Task "${title}" (${taskId}) finished.`
              : `Task "${title}" (${taskId}) is blocked.`,
            outcome.blocker ? `Blocker: ${outcome.blocker}` : null,
            outcome.changedFiles.length > 0
              ? `Changed files: ${outcome.changedFiles.length}`
              : null,
            outcome.pullRequest ? `PR: ${outcome.pullRequest.url}` : null,
            "Call studio_task_status with this taskId for full evidence.",
          ]
            .filter((line): line is string => line !== null)
            .join("\n");
          await notifyRequester(lines);
        })
        .catch(async (err) => {
          await taskStore.markInterrupted(taskId, String(err));
          await notifyRequester(
            `Task "${title}" (${taskId}) was interrupted: ${String(err)}`,
          );
        })
        .finally(() => {
          inFlight.delete(taskId);
        });

      return { ok: true, taskId, background, kind: taskKind };
    },
  };
}
