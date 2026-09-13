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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type BrokeredAccount,
  BrokeredAccountRow,
} from "@/components/plugins/brokered-account-row";
import type { BrokerField } from "@/lib/plugins/mutations";
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

/** When the key was last known to work, as this deployment wrote it down. */
const CHECKED_AT = "2026-09-10T09:00:00.000Z";

/** When a re-check pressed during a test finds out again. A different day, so the two read apart. */
const RECHECKED_AT = "2026-09-13T09:00:00.000Z";

/** The same day, spelled the way the row spells it — the reader's own locale, not this file's. */
function asDay(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** A minimal but complete brokered `PluginServer` — the row shape only Composio produces. */
function brokeredServer(authScheme: string): PluginServer {
  return {
    authScheme,
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

function pluginsPage(
  composioConfigured: boolean,
  authScheme: string,
): PluginsPage {
  return {
    catalogue: [],
    servers: [brokeredServer(authScheme)],
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
  /**
   * How this app's authorization config was created, as the vendor's own scheme literal. Defaults
   * to the consent scheme, which is what every test written before there was a second kind meant.
   */
  authScheme?: string;
  /** What the app publishes as the things a person types in, for the `API_KEY` schemes. */
  fields?: BrokerField[];
  /** Whether a real call was ever made with this key and worked, as this deployment recorded it. */
  verified?: boolean;
  /** When that happened. Null wherever `verified` is false — a check that failed records no time. */
  verifiedAt?: string | null;
  /** What a re-check answers when somebody presses for one. */
  recheckAnswer?: { verified: boolean; verifiedAt: string | null };
  /** What Composio refuses a submitted key with, where this deployment refuses it at all. */
  rejects?: string;
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
  const state = {
    authScheme: "OAUTH2",
    fields: [] as BrokerField[],
    verified: false,
    verifiedAt: null as string | null,
    rejects: undefined as string | undefined,
    recheckAnswer: { verified: true, verifiedAt: RECHECKED_AT },
    ...deployment,
  };
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
                verified: state.verified,
                verifiedAt: state.verifiedAt,
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
    /*
     * The first press on an app nobody consents to: what does it want typed in? The consent half of
     * this same route carries `?returnTo=`, so the two are told apart by the query rather than by
     * the method they share.
     */
    if (path.endsWith("/connect") && method === "POST") {
      /*
       * The second press carries the values on it, and is the one that writes. Told apart by the
       * body rather than by a second path, because the route itself is one route: the first press
       * asks the app what it wants and the second hands it over.
       */
      if (typeof init?.body === "string" && init.body.includes("values")) {
        /*
         * The vendor's own refusal, carried on the envelope `client` unwraps. It is the sentence
         * this whole path exists to preserve, and the only thing that tells somebody their key was
         * mistyped rather than their deployment broken.
         */
        if (state.rejects) {
          return new Response(JSON.stringify({ error: state.rejects }), {
            headers: { "content-type": "application/json" },
            status: 400,
          });
        }
        state.recorded = true;
        state.confirms = true;
        // A fresh key, and the store writes every one of those unverified: nothing has been spent
        // on it, whatever the app does or does not publish to spend.
        state.verified = false;
        state.verifiedAt = null;
        return json({ connected: true, verified: false });
      }
      return json({ fields: state.fields });
    }
    if (path.endsWith("/connection/recheck") && method === "POST") {
      state.verified = state.recheckAnswer.verified;
      state.verifiedAt = state.recheckAnswer.verifiedAt;
      return json(state.recheckAnswer);
    }
    if (path.endsWith("/connection") && method === "DELETE") {
      server.deletes += 1;
      state.recorded = false;
      state.confirms = false;
      // The row is gone, and so is everything that was ever checked about it.
      state.verified = false;
      state.verifiedAt = null;
      return json({ ok: true });
    }
    if (path.startsWith("/api/agents")) return json({ agents: [] });
    if (path.startsWith("/api/plugins")) {
      return json(pluginsPage(state.composioConfigured, state.authScheme));
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

/**
 * One real field, as Composio publishes it for Perplexity.
 *
 * Kept verbatim rather than trimmed to a label: the help sentence is the app's own, and the point of
 * the test below is that this deployment reproduces a sentence it has never been taught.
 */
const PERPLEXITY_KEY: BrokerField = {
  name: "generic_api_key",
  label: "API Key",
  help: "Your secret Perplexity API key, starting with 'pplx-'. Create one at console.perplexity.ai under API Keys — it's shown only once, so copy it immediately.",
  required: true,
  secret: true,
};

test("a key app asks for what the app asked for, with its own help text", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));

  // Labelled by what the app called it, which is how a person finds the box the vendor's own
  // instructions are about.
  const input = await view.findByLabelText("API Key");
  // The app said which value is the secret. Nothing here guessed it from the name.
  expect(input.getAttribute("type")).toBe("password");
  expect(view.queryByText(/starting with 'pplx-'/)).toBeTruthy();
});

test("a key app nobody has connected says it will ask for a key, not send you off", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(
      /connected with a key you already hold, not a trip to Gmail's consent screen/,
    ),
  ).toBeTruthy();
  /*
   * The screen's own not-connected sentence is written for the kind that leaves, and pressing
   * Connect on this app opens a form instead. Promising a trip to the vendor here is not a vaguer
   * sentence than the truth; it is a different act from the one about to happen.
   */
  expect(
    view.queryByText(/takes you to Composio and then to the vendor to consent/),
  ).toBeNull();
});

test("a key app nobody has connected keeps the screen's own reassurance", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
  });

  const view = renderAdminScreen(queryClient());

  // The row's own sentence, which is the one the screen's cannot be: pressing Connect here opens a
  // form rather than leaving for a consent screen.
  expect(await view.findByText(/Connect asks for it\./)).toBeTruthy();
  /*
   * And the half of the screen's line that survives it. Replacing the whole line took away the one
   * thing an administrator reading this row needs to know — that the connector is finished whether
   * or not they ever connect themselves — and left them looking at a step they do not have to take.
   */
  expect(
    view.getByText(
      /Setup is complete without it, and it reaches your documents only/,
    ),
  ).toBeTruthy();
});

/** Composio's own words for a key it would not take, which is the sentence worth carrying. */
const REFUSED = "Composio rejected that key: invalid API key for perplexityai.";

test("a key the broker refuses says so inside the dialog, not only behind it", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: false,
    fields: [PERPLEXITY_KEY],
    recorded: false,
    rejects: REFUSED,
  });

  const view = renderAccountScreen(queryClient());

  await userEvent.click(await view.findByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(await view.findByLabelText("API Key"), "pplx-mistyped");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  /*
   * WHERE THE PERSON IS LOOKING. The screen's banner is behind this dialog's backdrop, so a
   * refusal that lands only there lands nowhere: the form sits open over it as though nothing had
   * been answered, and the one sentence that says "you mistyped it" rather than "we are broken" is
   * unreadable until somebody closes the thing they were trying to finish.
   */
  await waitFor(() => expect(within(dialog).queryByText(REFUSED)).toBeTruthy());
  // Reported to the screen as well, not instead: the dialog is closable and the reason outlives it.
  expect(view.getAllByText(REFUSED).length).toBe(2);
  // And the form stays up holding what was typed. A mistyped key is corrected, not retyped.
  expect(within(dialog).queryByLabelText("API Key")).toBeTruthy();
});

test("the row names the app rather than calling it the app", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
  });

  const view = renderAdminScreen(queryClient());

  /*
   * The point of every sentence that names the vendor is that it names a place somebody has to go:
   * the console where a key is rotated, the consent screen a connection rests on. A screen that
   * drew this row without handing over the title left them all saying "the app", which names
   * nowhere at all.
   */
  expect(
    await view.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(
    view.queryByText(/accepted without being checked against the app/),
  ).toBeNull();
});

/**
 * A `BrokeredAccount` standing on its own, for the cases that are about what the row SAYS.
 *
 * The hook is exercised through the two screens above, which is where its own defects live. These
 * cases differ only in the three facts the row branches on — `kind`, `connected`, `verified` — and
 * a deployment built for each would be testing the stub rather than the sentence.
 */
function accountState(overrides: Partial<BrokeredAccount>): BrokeredAccount {
  return {
    configured: true,
    connect: () => {},
    connected: false,
    connecting: false,
    disconnect: () => {},
    disconnected: false,
    disconnecting: false,
    fields: null,
    kind: "consent",
    recheck: () => {},
    rechecking: false,
    requestFields: () => {},
    requestingFields: false,
    submitFields: () => {},
    submittingFields: false,
    verified: false,
    verifiedAt: null,
    ...overrides,
  };
}

/** The row with both screens' arguments filled in, so only the account differs between cases. */
function renderRow(account: BrokeredAccount) {
  return render(
    <BrokeredAccountRow
      account={account}
      connectedDescription="A Bot granted its tools reads your Gmail as you."
      disconnectedDescription="No Bot can read this as you."
      title="Gmail"
    />,
  );
}

test("both kinds say Connected, and the line beneath says how", () => {
  const consent = renderRow(accountState({ connected: true, kind: "consent" }));

  expect(consent.getByText("Connected")).toBeTruthy();
  expect(consent.getByText(/through Gmail's consent screen/)).toBeTruthy();

  cleanup();

  const key = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  // The same word, deliberately: what differs between a consent screen and a key somebody typed is
  // not whether the account is live, and a second word for it would invite a distinction there is
  // no fact behind.
  expect(key.getByText("Connected")).toBeTruthy();
  expect(
    key.getByText(
      `Connected with a key you provided, last checked ${asDay(CHECKED_AT)}.`,
    ),
  ).toBeTruthy();
});

test("an app needing no account offers nothing to press", () => {
  const view = renderRow(accountState({ kind: "no-auth" }));

  // Not a disabled Connect, and not a Connect that would make an account nobody needs: there is no
  // account here to make, so there is no control.
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByText(/Gmail needs no account/)).toBeTruthy();
});

test("Re-check appears only where a check is possible, and asks when pressed", async () => {
  let checks = 0;
  const checkable = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      recheck: () => {
        checks += 1;
      },
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  await userEvent.click(checkable.getByRole("button", { name: "Re-check" }));
  expect(checks).toBe(1);

  cleanup();

  /*
   * A key nothing has ever checked, which is every key on the day it is typed: the store writes
   * `verified: false` on every one of them. There is no check to repeat, so nothing is offered —
   * and the sentence does not say why, because this row is not told why.
   */
  const unchecked = renderRow(
    accountState({ connected: true, kind: "fields" }),
  );

  expect(unchecked.queryByRole("button", { name: "Re-check" })).toBeNull();
  expect(
    unchecked.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
});

test("a connected consent app offers no Re-check at all", () => {
  /*
   * WHAT A CONSENT ROW ACTUALLY LOOKS LIKE, and what every one of them was backfilled to by
   * migration 0030: connected and verified, with no probe anywhere behind the flag. Gating the
   * button on `verified` alone drew Re-check on all of them, and pressing it reached an endpoint
   * this deployment does not serve — a red banner, guaranteed, on the one kind that works today.
   */
  const view = renderRow(
    accountState({
      connected: true,
      kind: "consent",
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  expect(view.queryByRole("button", { name: "Re-check" })).toBeNull();
  // The row is otherwise itself: a live account somebody can still end.
  expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  expect(view.getByText(/through Gmail's consent screen/)).toBeTruthy();
});

test("disconnecting a key names the step this deployment cannot take", () => {
  const view = renderRow(
    accountState({ connected: false, disconnected: true, kind: "fields" }),
  );

  // The account ends at Composio and the key does not end anywhere. Saying "disconnected" and
  // stopping would leave somebody believing they had ended access they still have live.
  expect(view.getByText(/Removed from Composio/)).toBeTruthy();
  expect(
    view.getByText(/Your key still works at Gmail — rotate it there/),
  ).toBeTruthy();
});

test("a key re-checked and then disconnected stops claiming it was checked", async () => {
  installDeployment({
    authScheme: "API_KEY",
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: true,
    verifiedAt: CHECKED_AT,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(
      new RegExp(`last checked ${asDay(CHECKED_AT)}`.replace(/\//g, "\\/")),
    ),
  ).toBeTruthy();

  await userEvent.click(view.getByRole("button", { name: "Re-check" }));
  await waitFor(() =>
    expect(
      view.queryByText(
        new RegExp(`last checked ${asDay(RECHECKED_AT)}`.replace(/\//g, "\\/")),
      ),
    ).toBeTruthy(),
  );

  await userEvent.click(view.getByRole("button", { name: "Disconnect" }));

  await waitFor(() =>
    expect(view.queryByText(/Removed from Composio/)).toBeTruthy(),
  );
  // The account is gone; the answer the re-check gave was about it and must go with it.
  expect(view.queryByText(/last checked/)).toBeNull();
  expect(view.queryByRole("button", { name: "Re-check" })).toBeNull();

  /*
   * AND THE ANSWER MUST NOT COME BACK WITH THE NEXT KEY. A mutation's `data` is not query state:
   * without it being thrown away, connecting again leaves the re-check's old verdict standing, and
   * the row reads "last checked" about a key entered seconds ago that nothing has ever tried.
   */
  await userEvent.click(view.getByRole("button", { name: "Connect" }));
  const dialog = await view.findByRole("dialog");
  await userEvent.type(
    await view.findByLabelText("API Key"),
    "pplx-a-fresh-one",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );

  await waitFor(() => expect(view.queryByText("Connected")).toBeTruthy());
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(view.queryByText(/last checked/)).toBeNull();
});
