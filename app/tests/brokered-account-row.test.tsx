import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/settings/connected-accounts/$key";

/**
 * The brokered account row, on both screens that draw it.
 *
 * Neither screen had a test, which is how two defects survived a wave review and a final one.
 *
 * THE FIRST is that a successful disconnect went on reading "Connected". The row's state is
 * `confirmBrokered.data?.connected ?? <the recorded row>`, and a mutation's `data` is not query
 * state: disconnecting invalidated the queries, the recorded row went away, and the vendor's old
 * answer — set by the confirm-on-mount, whose dependencies had not changed — kept winning. The
 * person read that as a failure and pressed Disconnect again, and the second DELETE reached a store
 * method with no row-existence check, which revoked nothing and filed a second
 * `mcp.account_disconnected` entry about an account that was already gone.
 *
 * THE SECOND is a deployment with no Composio key. The confirm answers 503, both screens swallow
 * it by design, and the state fell back to the stale local row — so every reader was told
 * "Connected" on a deployment that cannot reach the broker at all, with no sign anything was wrong
 * until a Bot call refused. `docs/plugins/composio.md` has always claimed the page says the key is
 * missing; nothing implemented it.
 *
 * THE HARNESS IS THIS REPOSITORY'S, from `agent-roster-error.test.tsx` and
 * `bot-app-grants-screen.test.tsx`: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, a `QueryClient` with `retry: false`, and the
 * capture-and-restore of each exported `Route` singleton those files document at length — bun walks
 * every file into one process, and `.update()` merges into the live object rather than replacing it.
 *
 * What is NOT copied from them is the always-failing `fetch`. What is under test here is a sequence
 * — confirmed live, then disconnected, then read again — so the stub below is a small in-memory
 * deployment that answers each endpoint from state a test can set and a DELETE can change, rather
 * than one canned response. It also counts the DELETEs, which is the only way to assert the second
 * press cannot happen rather than merely that the word changed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const APP_KEY = "gmail";

/** A minimal but complete brokered `PluginServer` — the row shape only Composio produces. */
function brokeredServer(): PluginServer {
  return {
    id: APP_KEY,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid/composio",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    tools: [],
    withdrawn: [],
  };
}

function pluginsPage(composioConfigured: boolean): PluginsPage {
  return {
    catalogue: [],
    servers: [brokeredServer()],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured,
  };
}

/**
 * The deployment these tests render against, as a handful of facts a test sets up front.
 *
 * `recorded` is this deployment's own row — written from the unproven return trip from consent —
 * and `confirms` is what the broker answers when asked about the account behind it. They are
 * separate on purpose: every case worth testing here is one where the two disagree.
 */
type Deployment = {
  composioConfigured: boolean;
  recorded: boolean;
  confirms: boolean;
};

type Server = {
  /** How many DELETEs reached the connection endpoint. */
  deletes: number;
};

/**
 * A stub `fetch` answering the four endpoints these two screens read and write, from state the
 * DELETE actually changes.
 *
 * A canned response per endpoint would not do: the defect under test is a screen that keeps
 * rendering an answer the vendor gave BEFORE an act that invalidated it, so the disconnect has to
 * really take effect somewhere for a later read to be able to disagree with it.
 */
function installDeployment(deployment: Deployment): Server {
  const state = { ...deployment };
  const server: Server = { deletes: 0 };

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });

    if (path.startsWith("/api/plugins/connections")) {
      return json({
        connections: state.recorded
          ? [
              {
                serverId: APP_KEY,
                scope: "",
                connectedAt: "2026-09-10T00:00:00.000Z",
              },
            ]
          : [],
        redirectUri: null,
      });
    }
    if (path.endsWith("/connection/confirm") && method === "POST") {
      // What the route answers with no key at all: nothing to ask, and no answer invented.
      if (!state.composioConfigured) {
        return new Response(
          JSON.stringify({ error: "Composio is not set up" }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        );
      }
      return json({ connected: state.confirms });
    }
    if (path.endsWith("/connection") && method === "DELETE") {
      server.deletes += 1;
      state.recorded = false;
      state.confirms = false;
      return json({ ok: true });
    }
    if (path.startsWith("/api/agents")) return json({ agents: [] });
    if (path.startsWith("/api/plugins")) {
      return json(pluginsPage(state.composioConfigured));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return server;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client that settles in one attempt, so no test waits on a retry. */
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/*
 * Capture and restore of each exported `Route` singleton, verbatim from
 * `agent-roster-error.test.tsx` and for the reason recorded there: `.update()` merges into the live
 * object, `createRouter()` derives `_id`/`parentRoute` off it, and nothing re-runs `init()` on a
 * replay — so a render here would otherwise leave the real router (`router.test.ts` builds one in
 * this same bun process) pointed at a decoy parent.
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

/** Captured once, at module scope, before any `test()` body here has run — the state this file must
 *  hand back, whatever it happens to be. See `agent-roster-error.test.tsx`. */
const pristineAccountRouteState = captureRouteState(ConnectedAccountRoute);
const pristineAdminRouteState = captureRouteState(AdminAppRoute);

let accountRouteSnapshot: Record<string, unknown>;
let adminRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  accountRouteSnapshot = captureRouteState(pristineAccountRouteState);
  adminRouteSnapshot = captureRouteState(pristineAdminRouteState);
});

afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, accountRouteSnapshot);
  restoreRouteState(AdminAppRoute, adminRouteSnapshot);
});

/**
 * The personal screen, at its real id.
 *
 * `routeTree.gen.ts` fixes both halves: id `/connected-accounts/$key` under `/_authed/settings`,
 * path `/connected-accounts/$key`. Decoy pathless/static parents are enough to make the join land
 * on the id `useParams({ from: … })` resolves against; the real ancestors check a session and mount
 * the settings shell, neither of which this file is about. The index route is registered only so
 * the Back link has something to build an href from.
 */
function renderAccountScreen(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/connected-accounts/",
    getParentRoute: () => settingsRoute,
    component: () => null,
  });
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connected-accounts/$key",
    path: "/connected-accounts/$key",
    getParentRoute: () => settingsRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([settingsRoute.addChildren([indexRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/settings/connected-accounts/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The administrator's connector page, the same way: id `/plugins/$key` under `/_authed/admin`. */
function renderAdminScreen(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    AdminAppRoute as unknown as {
      update: (options: unknown) => typeof AdminAppRoute;
    }
  ).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/admin/plugins/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The sentence the row carries where the deployment has no Composio key, matched on the part that
 *  names the setting — the whole point of the row in that state. */
const NAMES_THE_SETTING = /Set COMPOSIO_API_KEY on this deployment/;

test("a disconnect that lands stops reading Connected and offers Connect again", async () => {
  const server = installDeployment({
    composioConfigured: true,
    recorded: true,
    confirms: true,
  });

  const view = renderAccountScreen(queryClient());

  // Connected first, on the vendor's own answer — otherwise the assertion below proves nothing.
  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  expect(view.queryByText("Connected")).toBeTruthy();

  await userEvent.click(disconnect);

  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Connect" })).toBeTruthy(),
  );
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  // The whole reason this matters: with Disconnect still on screen the person presses it again,
  // and the second DELETE files a row claiming an account was disconnected when there was none.
  expect(server.deletes).toBe(1);
});

test("a deployment with no Composio key names the setting and offers neither action", async () => {
  installDeployment({
    composioConfigured: false,
    // A row left over from when a key WAS set: the app keeps its row and its grants, which is the
    // exact state that used to read "Connected" on a deployment that cannot reach the broker.
    recorded: true,
    confirms: true,
  });

  const view = renderAccountScreen(queryClient());

  expect(await view.findByText(NAMES_THE_SETTING)).toBeTruthy();
  expect(view.queryByText("Key missing")).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});

test("somebody who abandoned consent reads as not connected, not as an error", async () => {
  installDeployment({
    composioConfigured: true,
    // The callback wrote our row on an ordinary redirect with nothing signed in it. The vendor is
    // the only thing that knows the consent was never finished, and it says so.
    recorded: true,
    confirms: false,
  });

  const view = renderAccountScreen(queryClient());

  expect(await view.findByRole("button", { name: "Connect" })).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  // Not a failure of this page: it asked a question and got an answer. A red sentence across the
  // top would report the page's own question as this person's problem.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText(NAMES_THE_SETTING)).toBeNull();
});

test("the connector's admin page draws the same row, and its disconnect clears too", async () => {
  const server = installDeployment({
    composioConfigured: true,
    recorded: true,
    confirms: true,
  });

  const view = renderAdminScreen(queryClient());

  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  expect(view.queryByText("Connected")).toBeTruthy();

  await userEvent.click(disconnect);

  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Connect" })).toBeTruthy(),
  );
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(server.deletes).toBe(1);
});

test("the admin page says the key is missing too, rather than offering an action", async () => {
  installDeployment({
    composioConfigured: false,
    recorded: true,
    confirms: true,
  });

  const view = renderAdminScreen(queryClient());

  expect(await view.findByText(NAMES_THE_SETTING)).toBeTruthy();
  expect(view.queryByText("Key missing")).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull();
  // The app is still enabled and still says how it is reached — the row is honest about what is
  // still true, rather than reading as a connector that has gone away.
  expect(view.queryByText("How this is reached")).toBeTruthy();
});
