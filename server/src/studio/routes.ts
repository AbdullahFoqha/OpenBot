/**
 * The browser-facing surface for the studio dashboard: project selection, setup status, task
 * submission, and the two testing actions (Check Setup, Run Coding Test).
 *
 * NOTHING HERE REPLACES `admission.ts`, `task-store.ts` OR THE CURSOR ADAPTER. This is the HTTP
 * door onto modules that already existed and already had real tests; it does not reimplement their
 * rules. What it adds is the parts that were genuinely missing: an in-memory registry of in-flight
 * runs so Stop Task can cancel something real, an idempotency map so a double-click does not create
 * two tasks, and the project-path verification the setup kit called out as unverified.
 */
import { spawn } from "node:child_process";
import { desc, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  studioEvidence,
  studioProducts,
  studioPullRequests,
  studioReservations,
  studioTasks,
} from "../db/schema";
import type { Admission } from "./admission";
import {
  createStudioDispatcher,
  resolveProjectPath,
  STUDIO_PRODUCT_ID,
  type StudioDispatcher,
} from "./dispatch";
import type { StudioPolicy } from "./policy";
import {
  CURSOR_ENGINEER_BOT_ID,
  DEFAULT_MODEL,
  runCodingTest,
  runProjectTask,
} from "./runner";
import type { TaskStore } from "./task-store";
import {
  archiveDynamicBot,
  createDynamicBot,
  getCatalogBot,
  listMergedBots,
  updateDynamicBot,
} from "./bot-catalog";

/** Runs `cmd` and resolves to its stdout, trimmed, or null if it could not be started or failed. */
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

async function cursorLoginStatus(): Promise<
  "online" | "needs_login" | "not_tested"
> {
  const out = await tryCommand(["cursor-agent", "status"]);
  if (out === null) return "not_tested";
  return /logged in/i.test(out) ? "online" : "needs_login";
}


export function createStudioRoutes(deps: {
  database: Database;
  admission: Admission;
  taskStore: TaskStore;
  policy: StudioPolicy;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Shared with Bot studio_* tools so chat and the dashboard start the same Cursor run. */
  dispatcher?: StudioDispatcher;
}): Hono<{ Variables: AppVariables }> {
  const { database, admission, taskStore, policy, requireUser } = deps;
  const dispatcher =
    deps.dispatcher ??
    createStudioDispatcher({ database, admission, taskStore });
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  /** In-flight dispatches, by task id. Lost on a server restart, same as any other live process. */
  const inFlight = dispatcher.inFlight;
  /** Idempotency: a client-supplied key to the task id it already produced. */
  const submitted = dispatcher.submitted;

  async function ensureProduct() {
    const existing = await database
      .select({ id: studioProducts.id })
      .from(studioProducts)
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
      .limit(1);
    if (existing.length === 0) {
      await taskStore.activateProduct({
        id: STUDIO_PRODUCT_ID,
        name: "OpenBot Product Studio",
      });
    }
  }

  routes.get("/setup", async (c: Context) => {
    const [dbCheck, cursorLogin, product] = await Promise.all([
      database
        .select({ id: studioProducts.id })
        .from(studioProducts)
        .limit(1)
        .then(() => "online" as const)
        .catch(() => "error" as const),
      cursorLoginStatus(),
      database
        .select({
          localPath: studioProducts.localPath,
          queuePaused: studioProducts.queuePaused,
        })
        .from(studioProducts)
        .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
        .limit(1),
    ]);

    let projectStatus: "online" | "not_tested" = "not_tested";
    let projectDetail = "No project selected yet.";
    const localPath = product[0]?.localPath ?? null;
    if (localPath) {
      const resolved = await resolveProjectPath(localPath);
      projectStatus = resolved.ok ? "online" : "not_tested";
      projectDetail = resolved.ok
        ? `${resolved.absolutePath} (git root ${resolved.gitRoot})`
        : resolved.reason;
    }

    const activeReservations = await admission.active();

    return c.json({
      server: "online",
      database: dbCheck,
      cursorLogin,
      project: { status: projectStatus, detail: projectDetail, path: localPath },
      queuePaused: product[0]?.queuePaused ?? false,
      policy: {
        maxActiveExecutionTasks: policy.maxActiveExecutionTasks,
        maxPrimaryExecutionTasksPerBot: policy.maxPrimaryExecutionTasksPerBot,
      },
      activeCount: activeReservations.length,
      nextAction:
        cursorLogin !== "online"
          ? "Run `cursor-agent login` in a terminal, then Check Setup again."
          : projectStatus !== "online"
            ? "Select a project (an absolute path to a local git checkout)."
            : "Setup looks ready. Run Coding Test to verify coding end to end.",
    });
  });

  routes.get("/project", async (c: Context) => {
    await ensureProduct();
    const [row] = await database
      .select({
        localPath: studioProducts.localPath,
        queuePaused: studioProducts.queuePaused,
      })
      .from(studioProducts)
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
      .limit(1);
    if (!row?.localPath) return c.json({ project: null });
    const resolved = await resolveProjectPath(row.localPath);
    return c.json({
      project: resolved.ok
        ? {
            path: resolved.absolutePath,
            gitRoot: resolved.gitRoot,
            verified: true,
          }
        : { path: row.localPath, gitRoot: null, verified: false, reason: resolved.reason },
      queuePaused: row.queuePaused,
    });
  });

  routes.post("/project", async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const path = typeof body?.path === "string" ? body.path.trim() : "";
    if (!path) return c.json({ error: "A project path is required." }, 400);
    const resolved = await resolveProjectPath(path);
    if (!resolved.ok) return c.json({ error: resolved.reason }, 400);

    await ensureProduct();
    await database
      .update(studioProducts)
      .set({ localPath: resolved.absolutePath })
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID));

    return c.json({
      project: { path: resolved.absolutePath, gitRoot: resolved.gitRoot, verified: true },
    });
  });

  routes.get("/tasks", async (c: Context) => {
    const active = await admission.active();
    const rows = await database
      .select()
      .from(studioTasks)
      .where(eq(studioTasks.productId, STUDIO_PRODUCT_ID))
      .orderBy(desc(studioTasks.updatedAt))
      .limit(50);
    const evidenceRows = await database.select().from(studioEvidence);
    const evidenceByTask = new Map(evidenceRows.map((e) => [e.taskId, e]));
    const activeByTask = new Map(active.map((a) => [a.taskId, a]));
    const pullRows = await database.select().from(studioPullRequests);
    const pullByTask = new Map(pullRows.map((p) => [p.taskId, p]));

    return c.json({
      tasks: rows.map((row) => {
        const pull = pullByTask.get(row.id);
        return {
          id: row.id,
          title: row.title,
          state: row.state,
          goal: row.goal,
          acceptanceCriteria: row.acceptanceCriteria,
          blockedReason: row.blockedReason,
          ownerBotId: row.ownerBotId,
          updatedAt: row.updatedAt,
          reservation: activeByTask.get(row.id) ?? null,
          evidence: evidenceByTask.get(row.id) ?? null,
          pullRequest:
            pull?.number && pull.url
              ? {
                  number: pull.number,
                  url: pull.url,
                  draft: pull.draft,
                  headBranch: pull.headBranch,
                  baseBranch: pull.baseBranch,
                }
              : null,
          running: inFlight.has(row.id),
        };
      }),
    });
  });

  routes.post("/tasks", async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
    const acceptanceCriteria =
      typeof body?.acceptanceCriteria === "string" ? body.acceptanceCriteria.trim() : "";
    const idempotencyKey =
      typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null;
    const ownerBotId =
      typeof body?.ownerBotId === "string" ? body.ownerBotId.trim() : undefined;
    const maestroFlow =
      typeof body?.maestroFlow === "string" ? body.maestroFlow.trim() : undefined;
    const deviceUdid =
      typeof body?.deviceUdid === "string" ? body.deviceUdid.trim() : undefined;

    const result = await dispatcher.submit({
      title,
      goal,
      acceptanceCriteria,
      idempotencyKey,
      ...(ownerBotId ? { ownerBotId } : {}),
      ...(maestroFlow ? { maestroFlow } : {}),
      ...(deviceUdid ? { deviceUdid } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({
      taskId: result.taskId,
      ...(result.deduplicated ? { deduplicated: true } : {}),
    });
  });

  routes.post("/tasks/:id/stop", async (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) return c.json({ error: "A task id is required." }, 400);
    const wasRunning = dispatcher.abort(taskId);
    const running = wasRunning ? { aborted: true } : null;
    // Release whatever reservation this task currently has, read fresh from the row rather than
    // trusting a ticket this request never held.
    const [reservation] = await database
      .select()
      .from(studioReservations)
      .where(eq(studioReservations.taskId, taskId))
      .limit(1);
    if (reservation) {
      await admission.release({
        taskId,
        botId: reservation.botId,
        owner: reservation.claimedBy,
        fence: reservation.fence,
        leaseUntil: reservation.leaseUntil,
        expiresAt: reservation.expiresAt,
      });
    }
    await taskStore.markInterrupted(taskId, "Stopped by the user.");
    return c.json({
      status: running ? "interrupted" : "cancelled",
      note: running
        ? "The Cursor process group was sent SIGTERM. Its worktree and any evidence already written are preserved."
        : "No in-flight process was found on this server; the reservation, if any, was released.",
    });
  });

  routes.post("/tasks/:id/continue", async (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) return c.json({ error: "A task id is required." }, 400);
    const task = await taskStore.read(taskId);
    if (!task) return c.json({ error: "There is no such task." }, 404);
    if (!task.goal) {
      return c.json({ error: "This task has no recorded goal to resume." }, 400);
    }

    /*
     * No formal "resume" exists in admission.ts today: a suspended reservation can only be taken
     * over by `reclaim`, which requires the lease to already be expired. For a single local worker
     * that is not generally true, so this releases the existing reservation using the fence and
     * owner read fresh from its own row — not forged, the row's current values — and re-claims.
     * This is a real gap against the fencing guarantee `admission.ts` documents for a genuinely
     * concurrent worker; it is fine for one Mac with no second process racing it, and is reported
     * as a known limitation rather than silently presented as the same safety property.
     */
    const [reservation] = await database
      .select()
      .from(studioReservations)
      .where(eq(studioReservations.taskId, taskId))
      .limit(1);
    if (reservation && reservation.state === "held") {
      return c.json({ error: "This task is already running." }, 409);
    }
    if (reservation) {
      await admission.release({
        taskId,
        botId: reservation.botId,
        owner: reservation.claimedBy,
        fence: reservation.fence,
        leaseUntil: reservation.leaseUntil,
        expiresAt: reservation.expiresAt,
      });
    }

    const [product] = await database
      .select({ localPath: studioProducts.localPath })
      .from(studioProducts)
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID))
      .limit(1);
    if (!product?.localPath) return c.json({ error: "No project is selected." }, 400);
    const resolved = await resolveProjectPath(product.localPath);
    if (!resolved.ok) return c.json({ error: resolved.reason }, 400);

    const controller = new AbortController();
    inFlight.set(taskId, { controller, startedAt: Date.now() });
    void runProjectTask({
      admission,
      taskStore,
      database,
      productId: STUDIO_PRODUCT_ID,
      projectPath: resolved.absolutePath,
      taskId,
      botId: task.ownerBotId ?? CURSOR_ENGINEER_BOT_ID,
      title: task.title,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria ?? "",
    })
      .catch(async (err) => {
        await taskStore.setBlocked(taskId, String(err));
      })
      .finally(() => {
        inFlight.delete(taskId);
      });

    return c.json({ status: "resumed" });
  });

  routes.post("/queue/pause", async (c: Context) => {
    await ensureProduct();
    await database
      .update(studioProducts)
      .set({ queuePaused: true })
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID));
    return c.json({ queuePaused: true });
  });

  routes.post("/queue/resume", async (c: Context) => {
    await ensureProduct();
    await database
      .update(studioProducts)
      .set({ queuePaused: false })
      .where(eq(studioProducts.id, STUDIO_PRODUCT_ID));
    return c.json({ queuePaused: false });
  });

  routes.post("/coding-test", async (c: Context) => {
    await ensureProduct();
    const login = await cursorLoginStatus();
    if (login !== "online") {
      return c.json({
        ok: false,
        blocker:
          "cursor-agent is not logged in on this server's host. Run `cursor-agent login` and try again.",
      }, 409);
    }
    if (await admission.holdsWork(CURSOR_ENGINEER_BOT_ID)) {
      return c.json({
        error: "The Cursor Engineer already has a task in progress. One primary task per bot.",
      }, 409);
    }

    const taskId = `coding-test-${randomUUID()}`;
    await taskStore.createTask({
      id: taskId,
      productId: STUDIO_PRODUCT_ID,
      title: "Coding test: fix add() in the disposable fixture",
      kind: "execution",
      state: "ready",
    });

    const controller = new AbortController();
    inFlight.set(taskId, { controller, startedAt: Date.now() });
    void runCodingTest({ admission, taskStore, database, taskId, model: DEFAULT_MODEL })
      .catch(async (err) => {
        await taskStore.setBlocked(taskId, String(err));
      })
      .finally(() => {
        inFlight.delete(taskId);
      });

    // Not accepting a queue pause here: a coding test is a diagnostic action a person asked for by
    // name, not new work the queue would otherwise have picked up on its own.
    return c.json({ taskId, model: DEFAULT_MODEL, backend: "cli" });
  });

  routes.get("/tasks/:id", async (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) return c.json({ error: "A task id is required." }, 400);
    const task = await taskStore.read(taskId);
    if (!task) return c.json({ error: "There is no such task." }, 404);
    const [evidence] = await database
      .select()
      .from(studioEvidence)
      .where(eq(studioEvidence.taskId, taskId))
      .limit(1);
    const [reservation] = await database
      .select()
      .from(studioReservations)
      .where(eq(studioReservations.taskId, taskId))
      .limit(1);
    return c.json({
      task,
      evidence: evidence ?? null,
      reservation: reservation ?? null,
      running: inFlight.has(taskId),
    });
  });


  // --- P0.1 dynamic bots (studio_spawn_bot) ---
  routes.get("/bots", async (c: Context) => {
    const bots = await listMergedBots(database);
    return c.json({ bots });
  });

  routes.get("/bots/:id", async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const bot = await getCatalogBot(database, id);
    if (!bot) return c.json({ error: "No such bot." }, 404);
    return c.json({ bot });
  });

  routes.post("/bots", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || typeof body.name !== "string") {
      return c.json({ error: "id and name are required." }, 400);
    }
    const result = await createDynamicBot(database, {
      id: body.id,
      name: body.name,
      title: typeof body.title === "string" ? body.title : undefined,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      templateRoleId: typeof body.templateRoleId === "string" ? body.templateRoleId : undefined,
      avatarSeed: typeof body.avatarSeed === "string" ? body.avatarSeed : undefined,
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter((x): x is string => typeof x === "string")
        : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ botId: result.bot.id, name: result.bot.name, created: true, bot: result.bot }, 201);
  });

  routes.patch("/bots/:id", async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "JSON body required" }, 400);
    const result = await updateDynamicBot(database, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      avatarSeed: typeof body.avatarSeed === "string" ? body.avatarSeed : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ bot: result.bot });
  });

  routes.delete("/bots/:id", async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const result = await archiveDynamicBot(database, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, archived: id });
  });

  return routes;
}
