import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { ServerRowAmbiguousError } from "../src/plugins/access";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  PluginInvariantError,
} from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/**
 * What a refused add looks like to the administrator who made it.
 *
 * The store's refusals are tested where they are decided. What is worth pinning here is the mapping,
 * because an unmapped throw leaves the route on its default path: the refusal becomes a 500, the
 * screen says something went wrong, and a correctable mistake reads as a broken deployment. The
 * curated route mapped one refusal and not the other, which is exactly the shape that is invisible
 * until somebody hits it.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function appWith(
  addServer: () => Promise<never>,
  role: "admin" | "user" = "admin",
) {
  const store = {
    addServer,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return (body: unknown) =>
    app.request("http://openbot.test/api/plugins/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

describe("adding a curated server", () => {
  test("a refused credential comes back as a refusal with its reason", async () => {
    const request = appWith(async () => {
      throw new CustomServerRefusedError(
        "That is not a credential this server can use. Add the server's own token instead.",
      );
    });

    const response = await request({
      key: "google-drive",
      credentialId: "11111111-1111-1111-1111-111111111111",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "That is not a credential this server can use. Add the server's own token instead.",
    });
  });

  test("an unknown catalogue key still comes back the same way", async () => {
    const request = appWith(async () => {
      throw new CatalogueEntryUnknownError("nope");
    });

    expect((await request({ key: "nope" })).status).toBe(400);
  });

  test("a row the deployment cannot resolve comes back with its sentence", async () => {
    /*
     * ADDING REFRESHES, which is what puts this fault on this route.
     *
     * `addServer` asks the vendor what it offers before it answers — deliberately, so a bad
     * credential is reported now rather than the first time a Bot uses one — so everything
     * `refreshTools` raises arrives here as well: a vendor listing one action twice, a query of
     * ours failing, a row whose two columns contradict each other. Unmapped, all of it left the
     * route on the default path and the admin page said "That did not work", while the SAME fault
     * on the refresh button said which row and what to do about it.
     */
    const sentence =
      "notion: the actions this app listed were not stored, so what it already had is unchanged.";
    const request = appWith(async () => {
      throw new PluginInvariantError(sentence);
    });

    const response = await request({ key: "notion" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: sentence });
  });

  test("a failure that is not a refusal is not dressed up as one", async () => {
    // The must-not case. Mapping every throw to 400 would tell an administrator to correct their
    // input when the database is down, and would hide a real fault behind a message about
    // credentials.
    const request = appWith(async () => {
      throw new Error("the database is unreachable");
    });

    expect((await request({ key: "google-drive" })).status).toBe(500);
  });

  test("somebody who is not an administrator cannot add one at all", async () => {
    const request = appWith(async () => {
      throw new Error("the store must not be reached");
    }, "user");

    expect((await request({ key: "google-drive" })).status).toBe(403);
  });
});

/**
 * What a refresh that cannot be resolved at all looks like to the administrator who pressed it.
 *
 * CRITERION. A contradiction between two of this deployment's own columns comes back with a body
 * that names the row and says what to correct, on this route and only on this route.
 *
 * REASON. `ServerRowAmbiguousError` was mapped nowhere, so it left the route on the framework's
 * default path: a 500 whose body is not JSON, which the admin client turns into its fallback
 * sentence — "That did not work" — having found no `error` field to read. The one refusal that
 * names exactly which row is wrong was the one an operator could not see, while the same sentence
 * was reaching a model on the tool-call path. This route is admin-gated, which is what makes
 * showing it here the right answer and showing it anywhere else the wrong one.
 */
function refreshApp(
  refreshTools: () => Promise<never>,
  role: "admin" | "user" = "admin",
) {
  const store = {
    refreshTools,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return () =>
    app.request("http://openbot.test/api/plugins/servers/notion/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
}

describe("refreshing a server that cannot be resolved", () => {
  test("the administrator is told which row and what to do about it", async () => {
    const sentence =
      "notion is a server this deployment ships an entry for, and a row with that id says its " +
      "provenance is composio. Rename it, or correct its provenance.";
    const request = refreshApp(async () => {
      throw new ServerRowAmbiguousError(sentence);
    });

    const response = await request();

    // 409 rather than 500: nothing broke and nothing about the request was malformed. Two rows
    // disagree, and the request cannot be answered until one of them changes.
    expect(response.status).toBe(409);
    // A body at all is the fix. Unmapped, this was a 500 carrying no JSON, and the page said
    // "That did not work" because that is what it says when it finds no message.
    expect(await response.json()).toEqual({ error: sentence });
  });

  test("a failed query comes back as the reason, never as the statement", async () => {
    /*
     * The shape drizzle throws: `Failed query:` plus the whole statement, then `params:` and every
     * value bound to it, with the driver's own error on `cause`. It is on the same shelf as the
     * refusals above — not a vendor's doing, not the asker's to act on — so this route is where an
     * operator is told about it, and it is the one member of that shelf whose `message` must not be
     * what they are told.
     */
    const request = refreshApp(async () => {
      throw Object.assign(
        new Error(
          'Failed query: select "credential_id" from "mcp_user_credentials" where "user_id" = $1 params: someone',
        ),
        {
          query: 'select "credential_id" from "mcp_user_credentials"',
          params: ["someone"],
          cause: new Error("canceling statement due to statement timeout"),
        },
      );
    });

    const response = await request();
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string };
    // The reason, which is what an administrator can act on.
    expect(body.error).toContain(
      "canceling statement due to statement timeout",
    );
    // And none of the query. This route answers an administrator, but the browser it answers is
    // still on somebody's laptop and the sentence still ends up in a screenshot and a ticket.
    expect(body.error).not.toContain("Failed query");
    expect(body.error).not.toContain("params:");
    expect(body.error).not.toContain("mcp_user_credentials");
  });

  test("a failure that is not one of ours is still not dressed up as one", async () => {
    // The must-not case, the same one the add route above carries: a database that is down is not
    // a row an administrator can go and correct, and answering 409 would send them to do it.
    const request = refreshApp(async () => {
      throw new Error("the database is unreachable");
    });

    expect((await request()).status).toBe(500);
  });

  test("somebody who is not an administrator cannot press it at all", async () => {
    const request = refreshApp(async () => {
      throw new Error("the store must not be reached");
    }, "user");

    // Which is what makes showing the sentence above safe: nobody else reaches this route.
    expect((await request()).status).toBe(403);
  });
});

/**
 * Granting one Bot to another, through the API an administrator actually has.
 *
 * The grant table gained a `bot` kind and the store learned it, but these two endpoints did not.
 * Revoke rejected it outright, so enabling the capability meant writing a row by hand and revoking
 * it was not possible at all — while the design says a revoked grant applies to the very next hop.
 *
 * `kind` also arrives in a JSON body, so a type annotation on it is a comment. It is checked here.
 */
function grantsApp(
  role: "admin" | "user" = "admin",
  runsHere: (agentId: string) => boolean | undefined = (agentId) => {
    // Undefined is "no such Bot", which is what the store answers for one nobody registered.
    if (agentId === "never-registered") return undefined;
    return agentId !== "at-an-endpoint";
  },
) {
  const calls: Array<{ verb: string; kind: string; ref: string }> = [];
  const store = {
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
    grant: async (kind: string, ref: string) => {
      calls.push({ verb: "grant", kind, ref });
    },
    revoke: async (kind: string, ref: string) => {
      calls.push({ verb: "revoke", kind, ref });
    },
    skillOwner: async () => null,
    agentOwner: async () => null,
    agentRunsHere: async (agentId: string) => runsHere(agentId),
    agentIsRegistered: async (agentId: string) =>
      agentId !== "never-registered",
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return { calls, app };
}

describe("granting one Bot to another", () => {
  test("an administrator can grant it", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "grant", kind: "bot", ref: "knowledge" }]);
  });

  /*
   * The half that was missing entirely. "Nothing about who may address whom is cached in a process"
   * is only true if there is a way to stop it.
   */
  test("and revoke it again", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants?kind=bot&ref=knowledge&agentId=assistant",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "revoke", kind: "bot", ref: "knowledge" }]);
  });

  /*
   * It lets one Bot spend another's model calls, wake its computer and reach whatever that Bot may
   * reach. That is not an instruction somebody attaches to a coworker they own.
   */
  test("somebody who is not an administrator cannot", async () => {
    const { calls, app } = grantsApp("user");

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "An administrator decides which Bots may hand work to another Bot.",
    });
    expect(calls).toEqual([]);
  });

  test("a kind nobody defined is refused rather than written", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "anything",
          ref: "x",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * A grant that could never do anything.
 *
 * Handing work to another Bot is a tool this deployment executes, so it can only be offered to a run
 * this deployment builds. A Bot at its own endpoint runs its own loop and is handed descriptions of
 * what it may call back for; there is no callback path that would execute a hop. Stored anyway, the
 * grant reads as configured and nothing ever happens.
 */
describe("granting a hop to a Bot that runs somewhere else", () => {
  test("is refused, and says why", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "at-an-endpoint",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("its own endpoint");
    expect(calls).toEqual([]);
  });

  test("a Bot nobody has heard of is refused too", async () => {
    // Undefined is "no such Bot", which must not read as "runs somewhere else" or as permission.
    const { calls, app } = grantsApp("admin", () => undefined);

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "never-registered",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("There is no such Bot.");
    expect(calls).toEqual([]);
  });

  test("a Bot that does run here is granted as before", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "general-assistant",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "grant", kind: "bot", ref: "knowledge" }]);
  });
});

/**
 * What a refusal tells somebody who is not an administrator.
 *
 * This route only requires a signed-in user. Checking whether a Bot exists, and whether it runs
 * here, before checking the role handed out three distinguishable 403s and turned the refusal into
 * an oracle for other people's private Bots — the exact property `handoff.ts` collapses on purpose.
 */
describe("what a bot grant refusal reveals", () => {
  const refusalFor = async (
    agentId: string,
    role: "admin" | "user",
    ref = "knowledge",
  ) => {
    const { calls, app } = grantsApp(role);
    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bot", ref, agentId }),
      },
    );
    return { status: response.status, body: await response.json(), calls };
  };

  test("a non-administrator gets one answer, whatever the Bot is", async () => {
    const said = new Set<string>();
    for (const agentId of [
      "general-assistant",
      "at-an-endpoint",
      "never-registered",
    ]) {
      const { status, body, calls } = await refusalFor(agentId, "user");
      expect(status).toBe(403);
      expect(calls).toEqual([]);
      said.add(body.error);
    }
    // One sentence for all three, so nothing distinguishes "exists" from "does not".
    expect(said.size).toBe(1);
    expect([...said][0]).toBe(
      "An administrator decides which Bots may hand work to another Bot.",
    );
  });

  test("an administrator still gets the reason", async () => {
    expect((await refusalFor("at-an-endpoint", "admin")).body.error).toContain(
      "its own endpoint",
    );
    expect((await refusalFor("never-registered", "admin")).body.error).toBe(
      "There is no such Bot.",
    );
  });

  /*
   * The target is bare text with no foreign key. A typo stored happily, `message_bot` was offered,
   * and every hop then refused as not-granted.
   */
  test("a target nobody has heard of is refused", async () => {
    const { status, body, calls } = await refusalFor(
      "general-assistant",
      "admin",
      "never-registered",
    );
    expect(status).toBe(403);
    expect(body.error).toContain("no Bot called never-registered");
    expect(calls).toEqual([]);
  });
});

/*
 * The desk refuses a self-hop outright — "a Bot cannot hand work to itself" — so a grant of a Bot to
 * itself is dead the moment it is written, and reads as configured.
 */
describe("granting a Bot itself", () => {
  test("is refused rather than stored", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "general-assistant",
          agentId: "general-assistant",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("cannot be granted itself");
    expect(calls).toEqual([]);
  });
});

/**
 * The app directory an administrator picks a brokered app out of.
 *
 * TWO THINGS ARE BEING PINNED, and they are the two a reader would assume the vendor does for us.
 * The search is ours, because `@composio/core` forwards only category, managed_by, sort_by, cursor
 * and limit and drops a search term without saying so — a forwarded term comes back as an
 * unfiltered first page, which looks exactly like a result. And the slug on a POST is checked
 * against the directory that was just read, because that slug becomes the url every future call
 * for the app runs against.
 *
 * The no-broker answer is a 503 naming the setting rather than an empty list: an empty directory
 * and an absent one are different facts, and only one of them has a remedy.
 */
const DIRECTORY = [
  {
    slug: "slack",
    name: "Slack",
    description: "Post messages and read channels.",
    logo: null,
    categories: ["communication"],
    actionCount: 63,
  },
  {
    slug: "gmail",
    name: "Gmail",
    description: "Read and send mail.",
    logo: null,
    categories: ["communication"],
    actionCount: 24,
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Track issues.",
    logo: null,
    categories: ["project-management"],
    actionCount: 18,
  },
];

function directoryApp(
  /** Null is a deployment with no COMPOSIO_API_KEY, which is the shipped default. */
  listApps: (() => Promise<typeof DIRECTORY>) | null = async () => DIRECTORY,
  role: "admin" | "user" = "admin",
  /** What this deployment has already added, which is where `enabled` comes from. */
  servers: Array<{ id: string; url: string }> = [],
) {
  const added: Array<{ slug: string; title: string; by: string }> = [];
  const store = {
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => servers,
    listSkills: async () => [],
    listGrants: async () => [],
    addBrokeredApp: async (input: {
      slug: string;
      title: string;
      by: string;
    }) => {
      added.push(input);
      return { id: `composio-${input.slug}`, url: `composio://${input.slug}` };
    },
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
    // Positions 16-25 are the stores after it; the broker is 26, `composio`.
    ...(Array.from({ length: 10 }) as never[]),
    listApps ? ({ broker: { listApps } } as never) : undefined,
  );

  return { added, app };
}

describe("the Composio directory", () => {
  test("a deployment with no broker is told which setting to set", async () => {
    const { app } = directoryApp(null);

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    // 503 rather than `{ apps: [] }`. An empty directory and an absent one are different facts,
    // and a page shown the empty one draws "no apps available" over a deployment that simply has
    // no key.
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("COMPOSIO_API_KEY");
  });

  test("a search term filters the directory here, not at the vendor", async () => {
    /*
     * `@composio/core` forwards only category, managed_by, sort_by, cursor and limit, and silently
     * drops anything else — so a term handed to their client comes back as an unfiltered first
     * page that reads as a result. The filter is ours, over slug, name and description.
     */
    const { app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps?q=sla",
    );

    expect(response.status).toBe(200);
    expect(
      (await response.json()).apps.map((app: { slug: string }) => app.slug),
    ).toEqual(["slack"]);
  });

  test("an app is enabled by the url of the row, not by the row's id", async () => {
    // Which app a row is comes off its url and only off its url, because that is where the
    // transport reads it from. An id read as an app name is a different question wearing the same
    // answer's clothes.
    const { app } = directoryApp(undefined, "admin", [
      { id: "an-id-nobody-should-read", url: "composio://slack" },
    ]);

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    const apps = (await response.json()).apps as Array<{
      slug: string;
      enabled: boolean;
    }>;
    expect(apps.find((entry) => entry.slug === "slack")?.enabled).toBe(true);
    expect(apps.find((entry) => entry.slug === "gmail")?.enabled).toBe(false);
  });

  test("a slug the directory never answered with is refused", async () => {
    /*
     * THE VALIDATION IS THE WHOLE ROUTE. The slug becomes `composio://<slug>`, which is the url
     * every future call for the app is resolved against, so a slug nobody listed is a row pointing
     * at an app that does not exist — added, grantable, and dead at the first call.
     */
    const { added, app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "not-an-app" }),
      },
    );

    expect(response.status).toBe(400);
    expect(added).toEqual([]);
  });

  test("an app the directory does list is added", async () => {
    const { added, app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );

    expect(response.status).toBe(201);
    // The title comes off the directory entry, never off the request: the caller chose an app, not
    // a name for it.
    expect(added).toEqual([{ slug: "slack", title: "Slack", by: ADMIN.email }]);
  });

  test("somebody who is not an administrator sees none of it", async () => {
    // Enabling an app writes every one of its actions in front of a model, which is the same
    // decision as adding an MCP server and stays an administrator's.
    const { added, app } = directoryApp(undefined, "user");

    expect(
      (await app.request("http://openbot.test/api/plugins/composio/apps"))
        .status,
    ).toBe(403);

    const posted = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );
    expect(posted.status).toBe(403);
    expect(added).toEqual([]);
  });
});

/**
 * What one person's connected accounts are, when some of them are brokered.
 *
 * CRITERION. A brokered connection appears in `GET /connections` for the person who holds it, and
 * for nobody else, in the same list as this deployment's own OAuth connections.
 *
 * REASON. The route answered out of `connectionsFor` alone, which reads the vault's join table, so
 * an app connected through Composio was invisible to the browser however live it was. The settings
 * page could then only lie about it or say nothing, and it said nothing. The two reads are separate
 * because the tables are — one holds a refresh token, the other holds only the fact that Composio
 * said yes — and this pins that the API does not make the reader care which.
 *
 * SCOPING IS THE OTHER HALF, and it is a per-person read with no `requireAdmin` in front of it: a
 * union assembled from the wrong id would put somebody else's connected mailbox on this page.
 */
function connectionsApp(
  person: { id: string; email: string },
  held: Array<{ serverId: string; scope: string; connectedAt: string }>,
  brokered: Array<{
    userId: string;
    row: { serverId: string; scope: string; connectedAt: string };
  }>,
) {
  const store = {
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
    connectionsFor: async (userId: string) =>
      userId === person.id ? held : [],
    brokeredConnectionsFor: async (userId: string) =>
      brokered
        .filter((connection) => connection.userId === userId)
        .map((connection) => connection.row),
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { ...person, name: "Somebody", image: null },
        }),
      },
    } as never,
    { rolesForUser: async () => ["user"] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return () => app.request("http://openbot.test/api/plugins/connections");
}

const ASKER = { id: "user_asker", email: "asker@openbot.test" };
const SOMEBODY_ELSE = { id: "user_other", email: "other@openbot.test" };

describe("a person's own connections", () => {
  test("a brokered connection is in the list beside the OAuth ones", async () => {
    const request = connectionsApp(
      ASKER,
      [
        {
          serverId: "notion",
          scope: "read",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        {
          userId: ASKER.id,
          row: {
            serverId: "composio-slack",
            scope: "",
            connectedAt: "2026-02-02T00:00:00.000Z",
          },
        },
      ],
    );

    const response = await request();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connections: Array<{ serverId: string }>;
    };
    // Sorted, so two requests answer in the same order: concatenating two lists that are each
    // ordered within their own table does not produce an ordered list.
    expect(body.connections.map((row) => row.serverId)).toEqual([
      "composio-slack",
      "notion",
    ]);
  });

  test("and is nobody else's", async () => {
    // The must-not case. This route is behind `requireUser` and nothing else: a union read for the
    // wrong person would show one person's connected account on another person's settings page.
    const request = connectionsApp(
      SOMEBODY_ELSE,
      [],
      [
        {
          userId: ASKER.id,
          row: {
            serverId: "composio-slack",
            scope: "",
            connectedAt: "2026-02-02T00:00:00.000Z",
          },
        },
      ],
    );

    const response = await request();

    expect(response.status).toBe(200);
    expect((await response.json()).connections).toEqual([]);
  });
});

/**
 * The url a person is sent to when they connect a brokered app to their own account.
 *
 * A constant rather than a literal at each assertion, because the thing being asserted about it is
 * mostly where it does NOT appear: it is handed to the browser that asked and to nothing else.
 */
const AUTHORIZATION_URL = "https://backend.composio.dev/s/a-bearer-capability";

/**
 * One brokered app, added, and the person connecting their own account to it.
 *
 * WHICH APP THIS IS COMES OFF THE ROW'S URL. `listServers` answers one row whose url is
 * `composio://linear`, and the branch under test reads the app out of it with `toolkitOf` rather
 * than off the id — the id is a row name (`composio-linear`) and reading one as the other works
 * right up until somebody renames a row.
 *
 * `redirectUrl` NULL IS A DEPLOYMENT WITH NO COMPOSIO_API_KEY, the same way `directoryApp`'s null
 * listing is: there is no broker at all, which is the shipped default and a state the surface has
 * to answer honestly rather than by pretending nobody is connected.
 */
function brokeredApp(
  /** What this deployment already holds for this person and this app. Null is nobody connected. */
  connection: { connectedAt: string } | null = null,
  /** Null is a deployment with no COMPOSIO_API_KEY, which is the shipped default. */
  redirectUrl: string | null = AUTHORIZATION_URL,
) {
  const authorized: Array<{ userId: string; toolkit: string }> = [];
  const queried: Array<{ toolkit: string; userId: string }> = [];
  const confirmed: Array<{ toolkit: string; userId: string }> = [];
  const disconnected: Array<{ toolkit: string; userId: string }> = [];

  const store = {
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [
      {
        id: "composio-linear",
        url: "composio://linear",
        provenance: "composio",
      },
    ],
    listSkills: async () => [],
    listGrants: async () => [],
    brokeredConnection: async (input: { toolkit: string; userId: string }) => {
      queried.push(input);
      return connection;
    },
    confirmBrokeredConnection: async (input: {
      toolkit: string;
      userId: string;
    }) => {
      confirmed.push(input);
      return { connected: connection !== null };
    },
    disconnectBrokered: async (input: { toolkit: string; userId: string }) => {
      disconnected.push(input);
      return { vendorRevoked: true };
    },
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    // Connecting an account is not an administrator's act: an administrator adds the app once, and
    // then everybody connects their own.
    { rolesForUser: async () => ["user"] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
    // Positions 16-25 are the stores after it; the broker is 26, `composio`.
    ...(Array.from({ length: 10 }) as never[]),
    redirectUrl
      ? ({
          broker: {
            authorize: async (request: { userId: string; toolkit: string }) => {
              authorized.push(request);
              return { redirectUrl };
            },
          },
        } as never)
      : undefined,
  );

  return {
    authorized,
    queried,
    confirmed,
    disconnected,
    connect: (body: unknown) =>
      app.request(
        "http://openbot.test/api/plugins/servers/composio-linear/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
  };
}

describe("connecting a brokered app", () => {
  test("the link is minted for the session's own person, whatever the body says", async () => {
    /*
     * THE USER ID COMES FROM THE SESSION AND FROM NOWHERE ELSE.
     *
     * A brokered call opens whichever account the user id names, so a route that would take one
     * out of a request body is one POST away from attaching somebody else's Linear to this
     * person's row — or, the same defect turned around, minting a link that connects this person's
     * account under somebody else's name. It is the defect the prior art this design copies
     * shipped and fixed three separate times, which is why the body here carries a user id at all:
     * the assertion is that it changed nothing.
     */
    const { authorized, queried, connect } = brokeredApp();

    const response = await connect({ userId: "user_somebody_else" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorizationUrl: AUTHORIZATION_URL,
    });
    expect(authorized).toEqual([{ userId: ADMIN.id, toolkit: "linear" }]);
    // And the read that decided there was no connection yet asked about the same person.
    expect(queried).toEqual([{ toolkit: "linear", userId: ADMIN.id }]);
  });

  test("a brokered row never reaches the checks that belong to the OAuth flow", async () => {
    /*
     * The ordering, stated as its own case. This deployment has no OPENBOT_PUBLIC_URL and
     * `composio-linear` is in nobody's catalogue, so a brokered row that fell through to either of
     * the two checks below the branch would be answered "no public URL" or "is not connected as an
     * individual person" — the second of which is the opposite of true. Neither check applies: no
     * authorization code comes back to us, no refresh token is stored, and no redirect URI of ours
     * is registered anywhere.
     */
    const { connect } = brokeredApp();

    const body = await (await connect({})).json();

    expect(body.authorizationUrl).toBe(AUTHORIZATION_URL);
  });

  test("a second connection is refused with the step to take", async () => {
    const { authorized, connect } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await connect({});

    expect(response.status).toBe(409);
    // Naming the remedy rather than only refusing: the person has an account attached already, and
    // the only way to a new link is through disconnecting the one they have.
    expect(((await response.json()).error as string).toLowerCase()).toContain(
      "disconnect",
    );
    // And nothing was minted, which is the half that matters: a link handed out here would attach
    // a second account behind a row that already says connected.
    expect(authorized).toEqual([]);
  });

  test("a deployment with no broker is told which setting to set", async () => {
    // The same answer the directory gives, for the same reason: nobody was asked, and the remedy
    // is one environment variable long.
    const { connect } = brokeredApp(null, null);

    const response = await connect({});

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("COMPOSIO_API_KEY");
  });
});
