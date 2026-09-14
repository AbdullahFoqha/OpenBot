import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createPluginRoutes } from "../src/plugins/routes";

/**
 * Who may be granted another Bot to hand work to, now that a remote one sometimes can be.
 *
 * The refusal this exercises was flat and correct: a Bot at its own endpoint could not execute a
 * hop, so storing the grant would have stored a dead row. It is no longer true of every remote Bot,
 * and the interesting property is that it is still true of every UNREGISTERED one — a lift that
 * applied to all of them would hand a model a tool it announces and never invokes, which is worse
 * than handing it none.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin" as const,
};
const USER = {
  id: "user-1",
  email: "user@openbot.test",
  role: "user" as const,
};

const REMOTE = "remote-researcher";
const LOCAL = "built-in-lead";
const TARGET = "engineer";

function appWith(options: {
  actor: typeof ADMIN | typeof USER;
  registered?: Set<string>;
  withRegistry?: boolean;
}) {
  const registered = options.registered ?? new Set<string>();
  const granted: { kind: string; ref: string; agentId: string }[] = [];

  const store = {
    // Only what this route reads on the way to the decision under test.
    agentRunsHere: async (agentId: string) =>
      agentId === LOCAL ? true : agentId === REMOTE ? false : undefined,
    agentIsRegistered: async (ref: string) => ref === TARGET,
    grant: async (kind: string, ref: string, agentId: string) => {
      granted.push({ kind, ref, agentId });
    },
    revoke: async () => {},
  };

  const delegation = {
    isRegistered: async (agentId: string) => registered.has(agentId),
    declare: async (agentId: string) => {
      registered.add(agentId);
    },
    revoke: async (agentId: string) => {
      registered.delete(agentId);
    },
    list: async () =>
      [...registered].map((agentId) => ({
        agentId,
        declaredAt: new Date(0),
        verifiedAt: null,
        verifiedRunId: null,
        revokedAt: null,
      })),
  };

  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("actor", options.actor as never);
    await next();
  });
  app.route(
    "/api/plugins",
    createPluginRoutes(
      store as never,
      async (_context, next) => {
        await next();
      },
      async () => true,
      undefined,
      options.withRegistry === false ? undefined : (delegation as never),
    ),
  );

  return { app, granted, registered };
}

const grant = (app: Hono<{ Variables: AppVariables }>, agentId: string) =>
  app.request("http://openbot.test/api/plugins/grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "bot", ref: TARGET, agentId }),
  });

describe("granting one Bot to another", () => {
  test("an unregistered endpoint is still refused, and told what would change that", async () => {
    const { app, granted } = appWith({ actor: ADMIN });
    const response = await grant(app, REMOTE);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("registered as calling tools back"),
    });
    expect(granted).toHaveLength(0);
  });

  test("a registered endpoint may be granted", async () => {
    const { app, granted } = appWith({
      actor: ADMIN,
      registered: new Set([REMOTE]),
    });
    const response = await grant(app, REMOTE);
    expect(response.status).toBe(200);
    expect(granted).toEqual([{ kind: "bot", ref: TARGET, agentId: REMOTE }]);
  });

  test("a deployment that registered nothing behaves exactly as it did before", async () => {
    // No registry at all: the flat refusal, unchanged. A deployment that never adopted this feature
    // must not be able to reach the new path by accident.
    const { app, granted } = appWith({ actor: ADMIN, withRegistry: false });
    const response = await grant(app, REMOTE);
    expect(response.status).toBe(403);
    expect(granted).toHaveLength(0);
  });

  test("a Bot that runs here needs no registration, as it never did", async () => {
    const { app, granted } = appWith({ actor: ADMIN });
    expect((await grant(app, LOCAL)).status).toBe(200);
    expect(granted).toHaveLength(1);
  });

  test("a Bot that does not exist is still not an oracle for one that does", async () => {
    const { app } = appWith({ actor: ADMIN, registered: new Set([REMOTE]) });
    const response = await grant(app, "no-such-bot");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "There is no such Bot.",
    });
  });
});

describe("registering an endpoint", () => {
  const register = (app: Hono<{ Variables: AppVariables }>, body: unknown) =>
    app.request("http://openbot.test/api/plugins/delegation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("is an administrator's decision, like granting one Bot to another", async () => {
    const { app, registered } = appWith({ actor: USER });
    expect((await register(app, { agentId: REMOTE })).status).toBe(403);
    expect(registered.size).toBe(0);
  });

  test("an administrator registers a remote Bot, and the grant then succeeds", async () => {
    const { app, granted } = appWith({ actor: ADMIN });
    expect((await grant(app, REMOTE)).status).toBe(403);
    expect((await register(app, { agentId: REMOTE })).status).toBe(200);
    expect((await grant(app, REMOTE)).status).toBe(200);
    expect(granted).toHaveLength(1);
  });

  test("a built-in Bot cannot be registered, because it already hands work on directly", async () => {
    const { app, registered } = appWith({ actor: ADMIN });
    const response = await register(app, { agentId: LOCAL });
    expect(response.status).toBe(400);
    // Storing this would put a row on the screen that reads as a configured capability and means
    // nothing at all.
    expect(registered.size).toBe(0);
  });

  test("a Bot that does not exist cannot be registered", async () => {
    const { app } = appWith({ actor: ADMIN });
    expect((await register(app, { agentId: "no-such-bot" })).status).toBe(404);
  });

  test("a body that is not a Bot id is a bad request rather than a text comparison", async () => {
    const { app } = appWith({ actor: ADMIN });
    for (const body of [{}, { agentId: 42 }, { agentId: "   " }]) {
      expect((await register(app, body)).status).toBe(400);
    }
  });

  test("withdrawing is always allowed and takes effect on the next grant", async () => {
    const { app, registered } = appWith({
      actor: ADMIN,
      registered: new Set([REMOTE]),
    });
    expect((await grant(app, REMOTE)).status).toBe(200);
    const withdrawn = await app.request(
      `http://openbot.test/api/plugins/delegation?agentId=${REMOTE}`,
      { method: "DELETE" },
    );
    expect(withdrawn.status).toBe(200);
    expect(registered.size).toBe(0);
    expect((await grant(app, REMOTE)).status).toBe(403);
  });
});
