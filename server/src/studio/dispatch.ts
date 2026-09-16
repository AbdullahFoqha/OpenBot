/**
 * One place that starts a Studio project task on the Cursor CLI engineer.
 *
 * Shared by the dashboard HTTP routes and by Bot tools (studio_run_task), so Lead chat and the
 * Studio UI take the same path: admit → worktree → cursor-agent on the Cursor subscription →
 * optional draft PR. Not a second coding backend and not host-folder writes.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { studioProducts, studioTasks } from "../db/schema";
import type { Admission } from "./admission";
import { CURSOR_ENGINEER_BOT_ID, runProjectTask } from "./runner";
import type { TaskStore } from "./task-store";

export const STUDIO_PRODUCT_ID = "studio-local";

type InFlightRun = { controller: AbortController; startedAt: number };

export type SubmitStudioTaskInput = {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  idempotencyKey?: string | null;
  /** Defaults to the Cursor Engineer. Pass quality-engineer for a verify-focused run. */
  ownerBotId?: string;
  /** When true, do not re-run package.json test/typecheck after the worker. */
  skipVerify?: boolean;
};

export type SubmitStudioTaskResult =
  | { ok: true; taskId: string; deduplicated?: boolean }
  | { ok: false; status: 400 | 409; error: string };

async function tryCommand(cmd: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
  });
}

export async function resolveProjectPath(
  inputPath: string,
): Promise<
  { ok: true; absolutePath: string; gitRoot: string } | { ok: false; reason: string }
> {
  if (!inputPath.startsWith("/")) {
    return { ok: false, reason: "The path must be absolute." };
  }
  let real: string;
  try {
    real = await realpath(inputPath);
  } catch {
    return { ok: false, reason: `No such directory: ${inputPath}` };
  }
  const gitRoot = await tryCommand(["git", "rev-parse", "--show-toplevel"], real);
  if (!gitRoot) {
    return {
      ok: false,
      reason: `${real} is not inside a git repository, so the studio cannot give a worker its own branch there.`,
    };
  }
  return { ok: true, absolutePath: real, gitRoot };
}

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
}): StudioDispatcher {
  const { database, admission, taskStore } = deps;
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

      const [product] = await database
        .select({
          localPath: studioProducts.localPath,
          queuePaused: studioProducts.queuePaused,
        })
        .from(studioProducts)
        .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
        .limit(1);
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
      if (await admission.holdsWork(ownerBotId)) {
        return {
          ok: false,
          status: 409,
          error: `Bot ${ownerBotId} already has a task in progress. One primary task per bot.`,
        };
      }

      const resolved = await resolveProjectPath(product.localPath);
      if (!resolved.ok) {
        return { ok: false, status: 400, error: resolved.reason };
      }

      const taskId = `task-${randomUUID()}`;
      if (idempotencyKey) submitted.set(idempotencyKey, taskId);

      await taskStore.createTask({
        id: taskId,
        productId: STUDIO_PRODUCT_ID,
        title,
        kind: "execution",
        state: "ready",
      });
      await database
        .update(studioTasks)
        .set({ goal, acceptanceCriteria })
        .where(eq(studioTasks.id, taskId));

      const controller = new AbortController();
      inFlight.set(taskId, { controller, startedAt: Date.now() });

      void runProjectTask({
        admission,
        taskStore,
        database,
        productId: STUDIO_PRODUCT_ID,
        projectPath: resolved.absolutePath,
        taskId,
        botId: ownerBotId,
        title,
        goal,
        acceptanceCriteria,
        ...(input.skipVerify ? { verifyCommands: [] } : {}),
      })
        .catch(async (err) => {
          await taskStore.setBlocked(taskId, String(err));
        })
        .finally(() => {
          inFlight.delete(taskId);
        });

      return { ok: true, taskId };
    },
  };
}
