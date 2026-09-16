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
import { and, desc, eq } from "drizzle-orm";
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
import {
  getSelectedProduct,
  listProducts,
  registerProduct,
  selectProduct,
} from "./products";
import {
  getBrowserSession,
  startBrowserSession,
  stopBrowserSession,
  type BrowserStep,
} from "./browser-session";
import {
  getDesktopSession,
  startDesktopSession,
  stopDesktopSession,
  runDesktopActions,
  parseDesktopSteps,
} from "./desktop-session";
import type { BotMessaging } from "./bot-messaging";
import type { StudioChannelBus } from "./studio-channels";
import type { StudioMemoryStore } from "./studio-memory";
import type { StudioSkillPackStore } from "./studio-skill-packs";
import type { StudioRoutineBus } from "./studio-routines";
import type { StudioMcpBus } from "./studio-mcp-connectors";
import {
  ensureStudioVerifierBot,
  STUDIO_VERIFIER_BOT_ID,
} from "./studio-verifier";
import {
  createChatModelPrefsStore,
  encodeChatModel,
  listClaudeModels,
  listCursorModels,
  type ChatModelProvider,
} from "./chat-model-prefs";
import {
  intelligenceChannelMappings,
  studioChannels,
} from "../db/schema";

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
  /** P1.1 bot-to-bot messaging bus. */
  botMessaging?: BotMessaging;
  /** P1.2 multi-bot rooms. */
  studioChannelBus?: StudioChannelBus;
  /** P1.3 durable memory. */
  studioMemory?: StudioMemoryStore;
  /** P1.4 skill packs. */
  skillPackStore?: StudioSkillPackStore;
  /** P2.1 routines. */
  studioRoutineBus?: StudioRoutineBus;
  /** P2.3 MCP connectors. */
  studioMcpBus?: StudioMcpBus;
  /** Mint a deployment-scoped Intelligence thread id (session restart). */
  mintThreadId?: () => string;
}): Hono<{ Variables: AppVariables }> {
  const { database, admission, taskStore, policy, requireUser, botMessaging, studioChannelBus, studioMemory, skillPackStore, studioRoutineBus, studioMcpBus } = deps;
  const chatModelPrefs = createChatModelPrefsStore(database);
  const mintThreadId =
    deps.mintThreadId ?? (() => `thread_${randomUUID()}`);
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
      getSelectedProduct(database),
    ]);

    let projectStatus: "online" | "not_tested" = "not_tested";
    let projectDetail = "No project selected yet.";
    const localPath = product?.localPath ?? null;
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
      project: { status: projectStatus, detail: projectDetail, path: localPath, productId: product?.id ?? null },
      queuePaused: product?.queuePaused ?? false,
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
    const row = await getSelectedProduct(database);
    if (!row?.localPath) return c.json({ project: null, products: await listProducts(database) });
    const resolved = await resolveProjectPath(row.localPath);
    return c.json({
      project: resolved.ok
        ? {
            path: resolved.absolutePath,
            gitRoot: resolved.gitRoot,
            verified: true,
            productId: row.id,
            name: row.name,
          }
        : { path: row.localPath, gitRoot: null, verified: false, reason: resolved.reason, productId: row.id },
      queuePaused: row.queuePaused,
      products: await listProducts(database),
    });
  });

  routes.post("/project", async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const path = typeof body?.path === "string" ? body.path.trim() : "";
    if (!path) return c.json({ error: "A project path is required." }, 400);
    await ensureProduct();
    const result = await registerProduct(database, {
      path,
      name: typeof body?.name === "string" ? body.name : undefined,
      id: typeof body?.id === "string" ? body.id : undefined,
      select: true,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const resolved = await resolveProjectPath(result.product.localPath!);
    return c.json({
      project: resolved.ok
        ? { path: resolved.absolutePath, gitRoot: resolved.gitRoot, verified: true, productId: result.product.id }
        : { path: result.product.localPath, verified: false },
      product: result.product,
      created: result.created,
    });
  });

  routes.get("/products", async (c: Context) => {
    await ensureProduct();
    const products = await listProducts(database);
    const selected = await getSelectedProduct(database);
    return c.json({ products, selectedProductId: selected?.id ?? null });
  });

  routes.post("/products", async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const path = typeof body?.path === "string" ? body.path.trim() : "";
    if (!path) return c.json({ error: "A project path is required." }, 400);
    await ensureProduct();
    const result = await registerProduct(database, {
      path,
      name: typeof body?.name === "string" ? body.name : undefined,
      id: typeof body?.id === "string" ? body.id : undefined,
      select: body?.select !== false,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ product: result.product, created: result.created }, result.created ? 201 : 200);
  });

  routes.post("/products/:id/select", async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const result = await selectProduct(database, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ product: result.product });
  });

  routes.get("/tasks", async (c: Context) => {
    const active = await admission.active();
    const selected = await getSelectedProduct(database);
    const productId = selected?.id ?? STUDIO_PRODUCT_ID;
    const rows = await database
      .select()
      .from(studioTasks)
      .where(eq(studioTasks.productId, productId))
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
    const skipVerify = body?.skipVerify === true;
    const background =
      typeof body?.background === "boolean" ? body.background : undefined;

    const result = await dispatcher.submit({
      title,
      goal,
      acceptanceCriteria,
      idempotencyKey,
      ...(ownerBotId ? { ownerBotId } : {}),
      ...(maestroFlow ? { maestroFlow } : {}),
      ...(deviceUdid ? { deviceUdid } : {}),
      ...(skipVerify ? { skipVerify: true } : {}),
      ...(background !== undefined ? { background } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({
      taskId: result.taskId,
      ...(result.deduplicated ? { deduplicated: true } : {}),
      ...(result.background !== undefined ? { background: result.background } : {}),
      ...(result.kind ? { kind: result.kind } : {}),
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

    const product = await getSelectedProduct(database);
    if (!product?.localPath) return c.json({ error: "No project is selected." }, 400);
    const resolved = await resolveProjectPath(product.localPath);
    if (!resolved.ok) return c.json({ error: resolved.reason }, 400);

    const controller = new AbortController();
    inFlight.set(taskId, { controller, startedAt: Date.now() });
    void runProjectTask({
      admission,
      taskStore,
      database,
      productId: product.id,
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
    const selected = await getSelectedProduct(database);
    if (!selected) return c.json({ error: "No product selected." }, 400);
    await database
      .update(studioProducts)
      .set({ queuePaused: true })
      .where(eq(studioProducts.id, selected.id));
    return c.json({ queuePaused: true, productId: selected.id });
  });

  routes.post("/queue/resume", async (c: Context) => {
    await ensureProduct();
    const selected = await getSelectedProduct(database);
    if (!selected) return c.json({ error: "No product selected." }, 400);
    await database
      .update(studioProducts)
      .set({ queuePaused: false })
      .where(eq(studioProducts.id, selected.id));
    return c.json({ queuePaused: false, productId: selected.id });
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

    const selected = await getSelectedProduct(database);
    const taskId = `coding-test-${randomUUID()}`;
    await taskStore.createTask({
      id: taskId,
      productId: selected?.id ?? STUDIO_PRODUCT_ID,
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




  // --- P0.3 Mac desktop agent session ---
  routes.get("/desktop/session", (c: Context) => {
    return c.json({ session: getDesktopSession() });
  });

  routes.post("/desktop/session/start", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const steps = parseDesktopSteps(body?.steps);
    const result = await startDesktopSession({
      app: typeof body?.app === "string" ? body.app : undefined,
      steps,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ session: result.session }, 201);
  });

  routes.post("/desktop/session/action", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const steps = parseDesktopSteps(body?.steps ?? (body ? [body] : []));
    if (!steps.length) return c.json({ error: "steps (or a single action) required." }, 400);
    const result = await runDesktopActions(steps);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ session: result.session });
  });

  routes.post("/desktop/session/stop", async (c: Context) => {
    const result = await stopDesktopSession();
    return c.json({ ok: true, session: result.session });
  });






  // --- P1.5 Studio Verifier ---
  routes.post("/verifier/ensure", async (c: Context) => {
    const result = await ensureStudioVerifierBot(database);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ botId: result.botId, created: result.created });
  });

  routes.post("/verify", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.claim !== "string" || typeof body.title !== "string") {
      return c.json({ error: "title and claim are required." }, 400);
    }
    const ensured = await ensureStudioVerifierBot(database);
    if (!ensured.ok) return c.json({ error: ensured.error }, 400);
    const result = await dispatcher.submit({
      title: body.title,
      goal: body.claim,
      acceptanceCriteria: body.claim,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      ownerBotId: STUDIO_VERIFIER_BOT_ID,
      background: true,
      maestroFlow: typeof body.maestroFlow === "string" ? body.maestroFlow : undefined,
      deviceUdid: typeof body.deviceUdid === "string" ? body.deviceUdid : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json(
      {
        taskId: result.taskId,
        ownerBotId: STUDIO_VERIFIER_BOT_ID,
        deduplicated: result.deduplicated === true,
      },
      201,
    );
  });



  // --- P2.3 MCP connectors ---
  routes.get("/mcp/catalogue", async (c: Context) => {
    if (!studioMcpBus) return c.json({ error: "Studio MCP is not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const result = await studioMcpBus.catalogue(actorId);
    return c.json(result);
  });

  routes.post("/mcp/install", async (c: Context) => {
    if (!studioMcpBus) return c.json({ error: "Studio MCP is not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      instanceHost?: string;
    } | null;
    if (!body?.key?.trim()) return c.json({ error: "key is required." }, 400);
    const result = await studioMcpBus.install({
      key: body.key.trim(),
      instanceHost: body.instanceHost,
      by: actorId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, server: result.server }, 201);
  });

  routes.get("/mcp/status", async (c: Context) => {
    if (!studioMcpBus) return c.json({ error: "Studio MCP is not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const serverId = c.req.query("serverId") || undefined;
    const result = await studioMcpBus.status(actorId, serverId);
    return c.json(result);
  });

  routes.post("/mcp/connect", async (c: Context) => {
    if (!studioMcpBus) return c.json({ error: "Studio MCP is not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const body = (await c.req.json().catch(() => null)) as { serverId?: string } | null;
    if (!body?.serverId?.trim()) return c.json({ error: "serverId is required." }, 400);
    const result = await studioMcpBus.connectStart({
      serverId: body.serverId.trim(),
      userId: actorId,
      by: actorId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({
      ok: true,
      serverId: result.serverId,
      authorizationUrl: result.authorizationUrl,
    });
  });

  // --- P2.1 routines ---
  routes.get("/routines", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const routines = await studioRoutineBus.list(actorId);
    return c.json({
      routines: routines.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        instruction: r.instruction,
        schedule: r.schedule,
        timezone: r.timezone,
        enabled: r.enabled,
        nextRunAt: r.nextRunAt.toISOString(),
        channelId: r.channelId,
        channelName: r.channelName,
        channelDeleted: r.channelDeleted,
        lastRun: r.lastRun
          ? {
              status: r.lastRun.status,
              finishedAt: r.lastRun.finishedAt?.toISOString() ?? null,
            }
          : null,
      })),
      count: routines.length,
    });
  });

  routes.post("/routines", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const body = (await c.req.json().catch(() => null)) as {
      instruction?: string;
      cron?: string;
      timezone?: string;
      agentId?: string;
      channelId?: string;
    } | null;
    if (!body?.instruction?.trim() || !body?.cron?.trim()) {
      return c.json({ error: "instruction and cron are required." }, 400);
    }
    const result = await studioRoutineBus.create({
      ownerUserId: actorId,
      agentId: body.agentId?.trim() || "studio-lead",
      instruction: body.instruction.trim(),
      cron: body.cron.trim(),
      timezone: body.timezone?.trim() || "America/New_York",
      channelId: body.channelId?.trim(),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(
      {
        ok: true,
        routine: {
          id: result.routine.id,
          agentId: result.routine.agentId,
          channelId: result.routine.channelId,
          instruction: result.routine.instruction,
          cron: result.routine.cron,
          timezone: result.routine.timezone,
          enabled: result.routine.enabled,
          nextRunAt: result.routine.nextRunAt.toISOString(),
        },
      },
      201,
    );
  });

  routes.put("/routines/:id/enabled", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const id = c.req.param("id") as string;
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false." }, 400);
    }
    const result = body.enabled
      ? await studioRoutineBus.resume(actorId, id)
      : await studioRoutineBus.pause(actorId, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, id, enabled: body.enabled });
  });

  routes.post("/routines/:id/pause", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const id = c.req.param("id") as string;
    const result = await studioRoutineBus.pause(actorId, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, id, enabled: false });
  });

  routes.post("/routines/:id/resume", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const id = c.req.param("id") as string;
    const result = await studioRoutineBus.resume(actorId, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, id, enabled: true });
  });

  routes.delete("/routines/:id", async (c: Context) => {
    if (!studioRoutineBus) return c.json({ error: "Studio routines are not configured." }, 503);
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const id = c.req.param("id") as string;
    const result = await studioRoutineBus.remove(actorId, id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.body(null, 204);
  });

  // --- P1.4 skill packs ---
  routes.get("/skill-packs", async (c: Context) => {
    if (!skillPackStore) return c.json({ error: "Skill packs are not configured." }, 503);
    const packs = await skillPackStore.list();
    return c.json({ packs });
  });

  routes.post("/skill-packs", async (c: Context) => {
    if (!skillPackStore) return c.json({ error: "Skill packs are not configured." }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string") {
      return c.json({ error: "name is required." }, 400);
    }
    const skillsRaw = Array.isArray(body.skills) ? body.skills : [];
    const skills = [];
    for (const s of skillsRaw) {
      if (!s || typeof s !== "object") continue;
      const skill = s as Record<string, unknown>;
      if (
        typeof skill.slug === "string" &&
        typeof skill.title === "string" &&
        typeof skill.summary === "string" &&
        typeof skill.instructions === "string"
      ) {
        skills.push({
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          instructions: skill.instructions,
        });
      }
    }
    const result = await skillPackStore.create({
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      skills,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ pack: result.pack }, 201);
  });

  routes.post("/skill-packs/:id/attach", async (c: Context) => {
    if (!skillPackStore) return c.json({ error: "Skill packs are not configured." }, 503);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.botId !== "string") {
      return c.json({ error: "botId is required." }, 400);
    }
    const result = await skillPackStore.attach({
      packId: id,
      botId: body.botId,
      by: c.var.actor?.id ?? "dev-local-user",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({
      packId: result.pack.id,
      botId: result.botId,
      grantedSlugs: result.grantedSlugs,
      pack: result.pack,
    });
  });

  routes.get("/bots/:id/skill-packs", async (c: Context) => {
    if (!skillPackStore) return c.json({ error: "Skill packs are not configured." }, 503);
    const botId = c.req.param("id");
    if (!botId) return c.json({ error: "id required" }, 400);
    const packs = await skillPackStore.listForBot(botId);
    return c.json({ packs });
  });

  // --- P1.3 durable memory ---
  routes.get("/bots/:id/memory", async (c: Context) => {
    if (!studioMemory) return c.json({ error: "Studio memory is not configured." }, 503);
    const botId = c.req.param("id");
    if (!botId) return c.json({ error: "id required" }, 400);
    const q = c.req.query("q") ?? undefined;
    const scope = (c.req.query("scope") as "agent" | "user" | "all" | undefined) ?? "all";
    const memories = await studioMemory.recall({ botId, query: q, scope, limit: 50 });
    return c.json({ memories });
  });

  routes.post("/bots/:id/memory", async (c: Context) => {
    if (!studioMemory) return c.json({ error: "Studio memory is not configured." }, 503);
    const botId = c.req.param("id");
    if (!botId) return c.json({ error: "id required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.fact !== "string") {
      return c.json({ error: "fact is required." }, 400);
    }
    const scope = body.scope === "user" ? "user" : "agent";
    const result = await studioMemory.write({
      fact: body.fact,
      scope,
      tier: typeof body.tier === "string" ? (body.tier as "profile" | "log" | "note") : "log",
      botId: scope === "agent" ? botId : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ memory: result.memory }, 201);
  });

  routes.get("/memory/user", async (c: Context) => {
    if (!studioMemory) return c.json({ error: "Studio memory is not configured." }, 503);
    const q = c.req.query("q") ?? undefined;
    const memories = await studioMemory.recall({ query: q, scope: "user", limit: 50 });
    return c.json({ memories });
  });

  routes.post("/memory/user", async (c: Context) => {
    if (!studioMemory) return c.json({ error: "Studio memory is not configured." }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.fact !== "string") {
      return c.json({ error: "fact is required." }, 400);
    }
    const result = await studioMemory.write({
      fact: body.fact,
      scope: "user",
      tier: typeof body.tier === "string" ? (body.tier as "profile" | "log" | "note") : "log",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ memory: result.memory }, 201);
  });

  // --- P1.2 multi-bot rooms ---
  routes.get("/channels", async (c: Context) => {
    if (!studioChannelBus) return c.json({ error: "Studio channels are not configured." }, 503);
    const channels = await studioChannelBus.list();
    return c.json({ channels });
  });

  routes.post("/channels", async (c: Context) => {
    if (!studioChannelBus) return c.json({ error: "Studio channels are not configured." }, 503);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string") {
      return c.json({ error: "name is required." }, 400);
    }
    const members = Array.isArray(body.memberBotIds)
      ? body.memberBotIds.filter((x): x is string => typeof x === "string")
      : Array.isArray(body.members)
        ? body.members.filter((x): x is string => typeof x === "string")
        : [];
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const result = await studioChannelBus.create({
      name: body.name,
      memberBotIds: members,
      actorId,
      createdByBotId: typeof body.createdByBotId === "string" ? body.createdByBotId : "studio-lead",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ channel: result.channel }, 201);
  });

  routes.get("/channels/:id", async (c: Context) => {
    if (!studioChannelBus) return c.json({ error: "Studio channels are not configured." }, 503);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const channel = await studioChannelBus.get(id);
    if (!channel) return c.json({ error: "No such studio channel." }, 404);
    const messages = await studioChannelBus.listMessages(id, 50);
    return c.json({ channel, messages });
  });

  routes.post("/channels/:id/messages", async (c: Context) => {
    if (!studioChannelBus) return c.json({ error: "Studio channels are not configured." }, 503);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.message !== "string") {
      return c.json({ error: "message is required." }, 400);
    }
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const result = await studioChannelBus.post({
      studioChannelId: id,
      fromBotId: typeof body.fromBotId === "string" ? body.fromBotId : "studio-lead",
      message: body.message,
      actorId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ message: result.message, channel: result.channel }, 201);
  });

  // --- Chat model picker (Cursor subscription vs Claude OAuth) ---
  routes.get("/chat-models", async (c: Context) => {
    const [cursor, claude] = await Promise.all([
      listCursorModels(),
      Promise.resolve(listClaudeModels()),
    ]);
    return c.json({
      providers: [
        { id: "cursor", label: "Cursor (subscription)", models: cursor },
        { id: "claude", label: "Claude (Claude Code OAuth)", models: claude },
      ],
    });
  });

  routes.put("/chat-models", async (c: Context) => {
    // Alias: body may include channelId for a one-shot set from a generic form.
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.channelId !== "string") {
      return c.json({ error: "channelId, provider, and modelId are required." }, 400);
    }
    const provider = body.provider;
    const modelId = body.modelId;
    if (provider !== "cursor" && provider !== "claude") {
      return c.json({ error: "provider must be cursor or claude." }, 400);
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      return c.json({ error: "modelId is required." }, 400);
    }
    const userId = c.var.actor?.id ?? "dev-local-user";
    const pref = await chatModelPrefs.set(
      userId,
      body.channelId,
      provider as ChatModelProvider,
      modelId,
    );
    return c.json({ preference: pref });
  });

  routes.get("/channels/:channelId/chat-model", async (c: Context) => {
    const channelId = c.req.param("channelId");
    if (!channelId) return c.json({ error: "channelId required" }, 400);
    const userId = c.var.actor?.id ?? "dev-local-user";
    const preference = await chatModelPrefs.get(userId, channelId);
    return c.json({
      channelId,
      preference,
      defaultHint:
        "When preference is null, the bot uses chatModelForBot (Lead→cursor-grok-4.6-high, Designer→claude package default).",
    });
  });

  routes.put("/channels/:channelId/chat-model", async (c: Context) => {
    const channelId = c.req.param("channelId");
    if (!channelId) return c.json({ error: "channelId required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "JSON body required." }, 400);
    const provider = body.provider;
    const modelId = body.modelId ?? body.model;
    if (provider !== "cursor" && provider !== "claude") {
      return c.json({ error: "provider must be cursor or claude." }, 400);
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      return c.json({ error: "modelId is required." }, 400);
    }
    const userId = c.var.actor?.id ?? "dev-local-user";
    const pref = await chatModelPrefs.set(
      userId,
      channelId,
      provider as ChatModelProvider,
      modelId.trim(),
    );
    return c.json({
      preference: pref,
      encoded: encodeChatModel(provider, modelId.trim()),
    });
  });

  /**
   * Mint a fresh Intelligence thread for this channel and remaps the user's mapping
   * so the next turn starts clean under the (optionally updated) model.
   */
  routes.post("/channels/:channelId/chat-model/restart", async (c: Context) => {
    const channelId = c.req.param("channelId");
    if (!channelId) return c.json({ error: "channelId required" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = c.var.actor?.id ?? "dev-local-user";

    // Optional: apply preference in the same call.
    const provider = body.provider;
    const modelId = body.modelId ?? body.model;
    let preference = await chatModelPrefs.get(userId, channelId);
    if (
      (provider === "cursor" || provider === "claude") &&
      typeof modelId === "string" &&
      modelId.trim()
    ) {
      preference = await chatModelPrefs.set(
        userId,
        channelId,
        provider,
        modelId.trim(),
      );
    }

    const threadId = mintThreadId();
    const now = new Date();
    const updated = await database
      .update(intelligenceChannelMappings)
      .set({ threadId, updatedAt: now })
      .where(
        and(
          eq(intelligenceChannelMappings.userId, userId),
          eq(intelligenceChannelMappings.channelId, channelId),
        ),
      )
      .returning({
        channelId: intelligenceChannelMappings.channelId,
        threadId: intelligenceChannelMappings.threadId,
      });

    if (updated.length === 0) {
      // Channel may exist without a mapping row yet — insert.
      await database.insert(intelligenceChannelMappings).values({
        userId,
        channelId,
        threadId,
      });
    }

    // Keep studio multi-bot room mapping in sync when this channel backs one.
    await database
      .update(studioChannels)
      .set({ threadId })
      .where(eq(studioChannels.channelId, channelId));

    return c.json({
      channelId,
      threadId,
      preference,
      restarted: true,
    });
  });

  // --- P1.1 bot-to-bot messaging ---
  routes.post("/bots/:id/messages", async (c: Context) => {
    if (!botMessaging) return c.json({ error: "Bot messaging is not configured." }, 503);
    const toBotId = c.req.param("id");
    if (!toBotId) return c.json({ error: "id required" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.message !== "string") {
      return c.json({ error: "message is required." }, 400);
    }
    const actorId = c.var.actor?.id ?? "dev-local-user";
    const result = await botMessaging.send({
      fromBotId: typeof body.fromBotId === "string" ? body.fromBotId : "studio-lead",
      toBotId,
      message: body.message,
      priority: body.priority === false ? false : true,
      actorId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(
      {
        messageId: result.message.id,
        priority: result.message.priority,
        woke: result.woke,
        channelId: result.message.channelId,
        threadId: result.message.threadId,
        message: result.message,
      },
      201,
    );
  });

  routes.get("/bots/:id/messages", async (c: Context) => {
    if (!botMessaging) return c.json({ error: "Bot messaging is not configured." }, 503);
    const toBotId = c.req.param("id");
    if (!toBotId) return c.json({ error: "id required" }, 400);
    const messages = await botMessaging.listInbox(toBotId, 50);
    return c.json({ messages });
  });

  // --- P0.4 browser agent session ---
  routes.get("/browser/session", (c: Context) => {
    return c.json({ session: getBrowserSession() });
  });

  routes.post("/browser/session/start", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.url !== "string") {
      return c.json({ error: "url is required." }, 400);
    }
    const stepsRaw = Array.isArray(body.steps) ? body.steps : [];
    const steps: BrowserStep[] = [];
    for (const s of stepsRaw) {
      if (!s || typeof s !== "object") continue;
      const step = s as Record<string, unknown>;
      if (step.action === "wait" && typeof step.ms === "number") {
        steps.push({ action: "wait", ms: step.ms });
      } else if (step.action === "screenshot") {
        steps.push({
          action: "screenshot",
          name: typeof step.name === "string" ? step.name : undefined,
        });
      } else if (step.action === "click" && typeof step.selector === "string") {
        steps.push({ action: "click", selector: step.selector });
      } else if (
        step.action === "type" &&
        typeof step.selector === "string" &&
        typeof step.text === "string"
      ) {
        steps.push({ action: "type", selector: step.selector, text: step.text });
      }
    }
    const result = await startBrowserSession({
      url: body.url,
      steps,
      headless: body.headless === false ? false : true,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ session: result.session }, 201);
  });

  routes.post("/browser/session/stop", async (c: Context) => {
    const result = await stopBrowserSession();
    return c.json({ ok: true, session: result.session });
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
