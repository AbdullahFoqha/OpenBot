import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  studioProducts,
  studioReservations,
  studioTasks,
} from "../src/db/schema";
import { createAdmission } from "../src/studio/admission";
import { DEFAULT_STUDIO_POLICY } from "../src/studio/policy";
import { createStudioRoutes } from "../src/studio/routes";
import { createTaskStore } from "../src/studio/task-store";
import { testDatabaseUrl } from "./support/database";

/**
 * Stop Task must not leave a row forever in `in_progress` with only blocked_reason set.
 * That stuck Active Work (launcher-guard-test) until someone hand-edited the DB.
 */

const database = createDatabase(testDatabaseUrl(), { max: 4 });
const suite = randomUUID().slice(0, 8);
const PRODUCT = `stop-settle-product-${suite}`;
const BOT = `stop-settle-bot-${suite}`;
const tasks = createTaskStore(database);
const admission = createAdmission(database, { ...DEFAULT_STUDIO_POLICY });

async function clean() {
  await database
    .delete(studioReservations)
    .where(sql`${studioReservations.taskId} like ${`${suite}-%`}`);
  await database.delete(studioTasks).where(like(studioTasks.id, `${suite}-%`));
  await database.delete(studioProducts);
  await database.delete(agents).where(like(agents.id, "stop-settle-bot-%"));
}

beforeEach(async () => {
  await clean();
  await database
    .insert(agents)
    .values({ id: BOT, name: BOT, type: "built_in", configuration: {} })
    .onConflictDoNothing();
  await tasks.activateProduct({ id: PRODUCT, name: "Stop settle" });
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("markInterrupted / Stop Task settle", () => {
  test("markInterrupted moves in_progress to in_review and sets blocked reason", async () => {
    const id = `${suite}-running`;
    await tasks.createTask({
      id,
      productId: PRODUCT,
      title: "Running then stopped",
      state: "ready",
    });
    await tasks.transition(id, "in_progress");
    await tasks.markInterrupted(id, "Stopped by the user.");
    const row = await tasks.read(id);
    expect(row?.state).toBe("in_review");
    expect(row?.blockedReason).toBe("Stopped by the user.");
  });

  test("markInterrupted on ready only sets the flag (no illegal skip to in_review)", async () => {
    const id = `${suite}-ready`;
    await tasks.createTask({
      id,
      productId: PRODUCT,
      title: "Ready only",
      state: "ready",
    });
    await tasks.markInterrupted(id, "Stopped by the user.");
    const row = await tasks.read(id);
    expect(row?.state).toBe("ready");
    expect(row?.blockedReason).toBe("Stopped by the user.");
  });

  test("POST /tasks/:id/stop settles an in_progress task via the HTTP door", async () => {
    const id = `${suite}-http-stop`;
    await tasks.createTask({
      id,
      productId: PRODUCT,
      title: "HTTP stop",
      state: "ready",
    });
    await tasks.transition(id, "in_progress");

    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        id: "dev-local-user",
        email: "dev@openbot.local",
        role: "admin",
      } as never);
      await next();
    });
    app.route(
      "/api/studio",
      createStudioRoutes({
        database,
        admission,
        taskStore: tasks,
        policy: { ...DEFAULT_STUDIO_POLICY },
        requireUser: async (_c, next) => {
          await next();
        },
        dispatcher: {
          inFlight: new Map(),
          submitted: new Map(),
          submit: async () => ({ ok: false, status: 400, error: "unused" }),
          abort: () => false,
        },
      }),
    );

    const response = await app.request(`http://openbot.test/api/studio/tasks/${id}/stop`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("cancelled");

    const row = await tasks.read(id);
    expect(row?.state).toBe("in_review");
    expect(row?.blockedReason).toBe("Stopped by the user.");
  });
});
