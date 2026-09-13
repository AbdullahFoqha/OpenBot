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

/**
 * The action Composio publishes for this app, as the server names it in an answer.
 *
 * A real name rather than a flag, because the name is the whole of what separates the two things
 * `verified: false` means: a null probe is an app with nothing safe to spend a key on, and this
 * beside the same false is a key the vendor looked at and refused.
 */
const PROBE = "GMAIL_FETCH_EMAILS";

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
  /**
   * Which action this deployment WOULD check the key with, as the connections read now derives it.
   *
   * Left off by default, because that is what a row out of the held-connection half of that
   * endpoint looks like and what every test written before the field existed meant: the key was
   * taken and nothing here knows what, if anything, tried it. A name or a null is the read saying
   * which of the three states the row is really in, and it survives a reload where an answer to a
   * mutation cannot.
   */
  probe?: string | null;
  /**
   * Whether the app has anything to check a key against today, as the connections read answers.
   *
   * A SECOND FIELD BECAUSE IT IS A SECOND QUESTION. `probe` above is the record of what the last
   * check SPENT; this is what the app publishes NOW, and it is what the Re-check button is drawn
   * from. They agree until an app starts publishing something it did not publish when the key was
   * taken — which is the state a deployment reaches by an administrator pressing Refresh, and the
   * one the button was unreachable in while it read the record.
   *
   * Left off by default for the same reason `probe` is, and false where it is left off: a held row
   * carries neither, and a closed gate is what a row nothing has said about should draw.
   */
  checkable?: boolean;
  /**
   * What a re-check answers when somebody presses for one, as the route's whole body.
   *
   * `probe` travels with the verdict because the verdict alone is not an answer: the only
   * `verified: false` that arrives here as a 200 is the one carrying a null probe, and a re-check
   * the vendor refused is raised rather than answered.
   */
  recheckAnswer?: {
    verified: boolean;
    verifiedAt: string | null;
    probe: string | null;
  };
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
    probe: undefined as string | null | undefined,
    checkable: false,
    recheckAnswer: { verified: true, verifiedAt: RECHECKED_AT, probe: PROBE },
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
                /*
                 * The action the last check recorded, so it is on every brokered row a page load
                 * reads and not only on the answer to a write. Undefined here is the field being
                 * absent from the JSON, which is what a held connection's row looks like.
                 */
                probe: state.probe,
                /*
                 * And what the app publishes today, which is the other question and the one the
                 * Re-check button asks. A read that sent only the record left the button gated on
                 * what a past check spent, so a key nothing was spent on could never have anything
                 * spent on it.
                 */
                checkable: state.checkable,
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
        /*
         * The route's whole body, `probe` included. This deployment's app publishes nothing safe to
         * spend a key on, which is what a null probe beside an unverified key says — and a stub that
         * left the field off would answer `undefined`, a state the server has no way to send.
         */
        return json({ connected: true, verified: false, probe: null });
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
 *
 * Every field of `BrokeredAccount` has to be kept here by hand: `app/tsconfig.json` covers `src`
 * and not `app/tests`, and `bun test` does not typecheck, so a field added to the type and missed
 * here is `undefined` at render time and nothing says so.
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
    /*
     * UNDEFINED IS THE DEFAULT BECAUSE IT IS THE COMMON STATE, not because the field is optional to
     * fill in: a row drawn from a page load has been told nothing about a probe, and the cases below
     * that are about the three the server DOES send say `null` or a name for themselves.
     */
    probe: undefined,
    /*
     * FALSE IS THE DEFAULT BECAUSE IT IS THE CLOSED GATE, and the cases below that are about the
     * Re-check button say so for themselves. It is the app's own question — is there anything to
     * check a key against today — and not the record `probe` above carries.
     */
    checkable: false,
    recheck: () => {},
    rechecking: false,
    requestFields: () => {},
    requestingFields: false,
    submissionError: null,
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
      // The app has something to spend the key on, which is the button's whole condition and is
      // asked of the app rather than of anything a past check recorded.
      checkable: true,
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
   * AN APP WITH NOTHING TO CHECK A KEY AGAINST, which is what the server answers `checkable: false`
   * for: no action it could safely spend the key on, so there is no check to make and nothing to
   * offer. Not the same as a key nothing has checked YET — a null RECORD keeps its button, because
   * the person who has just fixed their key is exactly who reaches for it, and because the record
   * is the only place an action can come from.
   */
  const unchecked = renderRow(
    accountState({
      checkable: false,
      connected: true,
      kind: "fields",
      probe: null,
    }),
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

/**
 * THE THREE THINGS A KEY CONNECTION'S VERIFICATION CAN MEAN, one test apiece.
 *
 * The row used to collapse all three into "It was accepted without being checked against Gmail",
 * which is vague for two of them and FALSE for the third: there the key was checked, the vendor
 * refused it, and the account that check ran in is still standing — so the one person whose key is
 * definitely bad, and whose account is definitely live at Composio, was told nothing had ever been
 * tried. `probe` is what tells them apart, and these are the three shapes it arrives in.
 */

test("an app with nothing to check a key against says that about the app", () => {
  /*
   * STATE ONE: a null probe beside an unverified key. The app publishes no action this deployment
   * could safely spend the key on, so nothing was tried and nothing can be — a fact about what the
   * app publishes, which is why the sentence has to say so rather than leave a person reading
   * suspicion of their own key into it.
   */
  const view = renderRow(
    accountState({ connected: true, kind: "fields", probe: null }),
  );

  expect(
    view.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(view.getByText(/publishes nothing safe to try a key on/)).toBeTruthy();
  expect(view.getByText(/about the app, not about your key/)).toBeTruthy();
  // The one thing this state must never read as: a verdict on the key.
  expect(view.queryByText(/rejected/)).toBeNull();
});

test("a key that passed its check says when it passed", () => {
  /*
   * STATE TWO: a named probe and a verdict that it answered. The action ran in this person's own
   * account and the vendor took the key — and because Composio never re-checks a key once it has
   * taken it, the sentence names the moment rather than asserting a present tense.
   */
  const view = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      probe: PROBE,
      verified: true,
      verifiedAt: CHECKED_AT,
    }),
  );

  expect(
    view.getByText(
      `Connected with a key you provided, last checked ${asDay(CHECKED_AT)}.`,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
});

test("a key the vendor rejected says so, and that the account still stands", () => {
  /*
   * STATE THREE, AND THE WHOLE REASON `probe` TRAVELS. It is reachable on the worst path from
   * either producer: the check ran, the vendor refused the key, and the account it ran in is still
   * standing — a connect whose withdrawal failed, or a re-check that never withdraws one. All three
   * facts are the person's to act on: the key is bad, an account of theirs is live at Composio, and
   * the row says which button ends which. WHY it stands is the one thing the sentence must not
   * assert, because the two paths stand for different reasons.
   */
  const view = renderRow(
    accountState({
      connected: true,
      kind: "fields",
      probe: PROBE,
      verified: false,
      verifiedAt: null,
    }),
  );

  expect(
    view.getByText(
      /was checked against Gmail and rejected, and the account it was checked in still stands at Composio/,
    ),
  ).toBeTruthy();
  // And never a cause for it: a failed re-check leaves the account standing without trying to take
  // it back, so a sentence blaming a failed withdrawal would be false on that path.
  expect(view.queryByText(/could not withdraw it/)).toBeNull();
  /*
   * AND NOT THE OTHER SENTENCE. This is the state that sentence was false in: saying nothing had
   * been checked, to the one person whose key has definitely been checked and definitely refused.
   */
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
});

test("Re-check is offered where the key is bad and withheld where there is nothing to check", async () => {
  /*
   * THE BUTTON BELONGS TO THE APP'S PROBE, NOT TO A CHECK THAT HAS ALREADY PASSED. Gating it on
   * `verified` hid it in state three, which is precisely where somebody stands after correcting the
   * key at the vendor and wanting to try it again — and the row that hid it also told them nothing
   * had ever been tried.
   */
  let checks = 0;
  const rejected = renderRow(
    accountState({
      // The app still publishes what the refused check was spent on, which is the ordinary shape of
      // this state and what puts the button within reach of somebody who has fixed their key.
      checkable: true,
      connected: true,
      kind: "fields",
      probe: PROBE,
      recheck: () => {
        checks += 1;
      },
      verified: false,
      verifiedAt: null,
    }),
  );

  await userEvent.click(rejected.getByRole("button", { name: "Re-check" }));
  expect(checks).toBe(1);

  cleanup();

  /*
   * And withheld where the app has nothing to check with. Pressing it there could only spend a
   * request to be told the same nothing again.
   */
  const nothingToCheck = renderRow(
    accountState({
      checkable: false,
      connected: true,
      kind: "fields",
      probe: null,
    }),
  );

  expect(nothingToCheck.queryByRole("button", { name: "Re-check" })).toBeNull();
  // Still a live account somebody can end: the missing button is about checking, not about acting.
  expect(
    nothingToCheck.getByRole("button", { name: "Disconnect" }),
  ).toBeTruthy();
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
    // The app publishes something to check the key against, so the button this test presses exists.
    checkable: true,
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

test("a rejected key still says so on a page that has only read, and still offers Re-check", async () => {
  /*
   * THE RELOAD, WHICH IS THE STATE THIS WHOLE FIELD WAS MISSING FROM. Nothing has been pressed
   * here: no key has just been handed over and no re-check has been made, so the hook holds no
   * mutation answer at all and everything the row knows came out of the connections read. That read
   * now derives `probe` from the app's recorded actions, which is what lets the three states behind
   * one `verified: false` survive a refresh.
   *
   * Before it did, this exact page said "accepted without being checked" — to the one person whose
   * key HAS been checked and refused, and whose account is standing at Composio. The button they
   * would reach for was withheld at the same time, on the only render where they would look for it.
   */
  installDeployment({
    authScheme: "API_KEY",
    // Still publishing what the refused check was spent on, which is what offers the way back.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: PROBE,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(/was checked against Gmail and rejected/),
  ).toBeTruthy();
  expect(view.getByText(/still stands at Composio/)).toBeTruthy();
  // And never the sentence that is false here.
  expect(
    view.queryByText(/accepted without being checked against Gmail/),
  ).toBeNull();
  // The way back: a key corrected at the vendor is worth a second check, not a second connection.
  expect(await view.findByRole("button", { name: "Re-check" })).toBeTruthy();

  cleanup();

  /*
   * AND THE SAME ON THE ADMINISTRATOR'S PAGE, which draws the same row from its own call. The two
   * screens wire the hook up separately, so a field carried into one of them and not the other is a
   * defect neither screen's other tests can see.
   */
  installDeployment({
    authScheme: "API_KEY",
    // Still publishing what the refused check was spent on, which is what offers the way back.
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: PROBE,
  });

  const admin = renderAdminScreen(queryClient());

  expect(
    await admin.findByText(/was checked against Gmail and rejected/),
  ).toBeTruthy();
  expect(await admin.findByRole("button", { name: "Re-check" })).toBeTruthy();
});

test("a key nothing was tried on offers Re-check once the app has something to try, and still says nothing was tried", async () => {
  /*
   * THE DEADLOCK, AND ITS GUARD, IN ONE ROW. The server records what a check SPENT and answers
   * separately whether the app has anything to spend TODAY, and this row is the state where those
   * two part company: a key accepted against an app that published nothing, under an app that
   * publishes something now.
   *
   * While the button read the record, this row had no way out. The check spent nothing, so the
   * record is null for good; the button was withheld on a null; and pressing that button is the
   * only thing in the product that could ever put an action in the record. Withholding it was the
   * safe direction for a question about the app and the wrong answer to it.
   *
   * AND THE SENTENCE MUST NOT MOVE WITH IT. What the row SAYS is drawn from the record, so it goes
   * on saying the key was taken and never tried — which is what happened, and stays what happened
   * however much the app has published since. A screen that let the button's question write the
   * sentence would be the accusation this record exists to prevent, arriving by the other door.
   */
  const row = renderRow(
    accountState({
      checkable: true,
      connected: true,
      kind: "fields",
      probe: null,
    }),
  );

  expect(row.getByRole("button", { name: "Re-check" })).toBeTruthy();
  expect(
    row.getByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  // And never the sentence written for a key the vendor refused: nothing was refused here.
  expect(row.queryByText(/and rejected/)).toBeNull();

  cleanup();

  /*
   * AND THE SAME OFF A PAGE THAT HAS ONLY READ, on both screens. Nothing is pressed here, so every
   * field the row branches on came out of the connections read — which is the only place the second
   * answer can come from, and the two screens wire the hook up separately.
   */
  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
  });

  const view = renderAccountScreen(queryClient());

  expect(
    await view.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(await view.findByRole("button", { name: "Re-check" })).toBeTruthy();

  cleanup();

  installDeployment({
    authScheme: "API_KEY",
    checkable: true,
    composioConfigured: true,
    confirms: true,
    fields: [PERPLEXITY_KEY],
    recorded: true,
    verified: false,
    verifiedAt: null,
    probe: null,
  });

  const admin = renderAdminScreen(queryClient());

  expect(
    await admin.findByText(/accepted without being checked against Gmail/),
  ).toBeTruthy();
  expect(await admin.findByRole("button", { name: "Re-check" })).toBeTruthy();
});
