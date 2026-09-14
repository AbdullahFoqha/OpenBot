import { afterEach, expect, test } from "bun:test";
import {
  type MutationFunctionContext,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query";
import * as pluginMutations from "../src/lib/plugins/mutations";
import {
  addCuratedServerMutationOptions,
  addCustomServerMutationOptions,
  brokeredConnectionFieldsMutationOptions,
  confirmBrokeredConnectionMutationOptions,
  connectBrokeredWithFieldsMutationOptions,
  disconnectBrokeredMutationOptions,
  enableComposioAppMutationOptions,
  recheckBrokeredConnectionMutationOptions,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "../src/lib/plugins/mutations";
import { pluginKeys } from "../src/lib/plugins/queries";

/**
 * What every plugin write does about the screen when the server says no.
 *
 * THE PROPERTY, STATED ONCE FOR A WHOLE FILE. Not one of these endpoints is atomic. Every one of
 * them writes — a row, an audit entry, a revoke at another company — and then does something else
 * that can fail, and Hono answers the failure with a status while the write stands. `POST /servers`
 * inserts the row and then refreshes its tools, and answers 409 when that refresh faults;
 * `POST /grants` upserts the grant and then files the trail row, and answers 500 when that insert
 * does; `DELETE /servers/:id/connection` revokes the account at Composio and then deletes the row.
 * A refusal from any of them is therefore NOT evidence that nothing changed, and a mutation that
 * refetched only on success left the screen asserting a state the deployment had already left.
 *
 * IT IS THE SAME DEFECT TWO REVIEWERS FOUND ON TWO ROUTES, and the reason it is tested here rather
 * than only where they found it: the shape is a property of the file, so a test per symptom would
 * have pinned two of fourteen and left the next one to be found the same way. Both of theirs are
 * below — a re-check the vendor refused, whose verdict the store wrote before raising, and a key
 * whose account Composio would not take back — beside the twelve that share their shape.
 *
 * THE STATUS EACH CASE SENDS IS THE ONE ITS OWN ROUTE SENDS, read off `server/src/plugins/routes.ts`
 * rather than chosen for convenience. A stub answering a shape a route cannot produce is what let
 * the two findings survive a review in the first place, and repeating that here would buy a green
 * file and nothing else.
 *
 * THROUGH A REAL `MutationObserver`, SO REACT QUERY DECIDES WHICH CALLBACKS RUN. Calling
 * `options.onSettled` by hand would pass against a file that merely declares the property, which is
 * not the question — the question is what happens to the screen when a press is refused.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A deployment that refuses every request with the status the route under test really sends.
 *
 * A body with `error` on it, because that is the envelope `client` unwraps and the sentence a
 * person reads — and because a refusal with no readable reason is a different test.
 */
function refusing(status: number, message: string) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/**
 * Drive one mutation to its refusal and report what it asked to be refetched.
 *
 * The rejection is swallowed here rather than allowed to fail the test: a refusal IS the case under
 * test, and what is being asserted is what the mutation did about the screen on its way out.
 */
async function refetchedOnRefusal<TVariables>(
  build: (queryClient: QueryClient) => unknown,
  variables: TVariables,
): Promise<unknown[]> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const asked: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: never) => {
    asked.push(filters);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const observer = new MutationObserver(
    queryClient,
    build(queryClient) as never,
  );
  let refused = false;
  await observer.mutate(variables as never).catch(() => {
    refused = true;
  });
  expect(refused).toBe(true);
  return asked;
}

/** What every one of these mutations has to ask for, and the only thing any of them asks for. */
const EVERY_PLUGIN_QUERY = [{ queryKey: pluginKeys.all }];

/**
 * The second argument react-query hands a `mutationFn`, for the one case below that calls one by hand.
 *
 * Spelled out rather than cast away, because `app/tests` sits outside `app/tsconfig.json` and
 * `bun test` does not typecheck — so a call written to the wrong arity here is a green test against
 * a signature that does not exist. None of these mutation functions reads it.
 */
function mutationContext(): MutationFunctionContext {
  return { client: new QueryClient(), meta: undefined };
}

/*
 * ONE CASE PER WRITE, AND THE STATUS IS EACH ROUTE'S OWN.
 *
 * 409 is `isDeploymentFault` on the admin routes that write a row and then refresh it. 500 is the
 * four routes with no catch at all, where the write lands and the audit insert behind it is what
 * throws. 502 is `brokerRefusal`'s generic arm on the brokered routes, and 400 is a refusal the
 * store itself authored — which on both brokered write paths is raised AFTER the row is written.
 */
const REFUSALS: {
  name: string;
  route: string;
  status: number;
  message: string;
  /**
   * THE FACTORY ITSELF, NOT A CLOSURE THAT CALLS ONE AND NOT ITS NAME AS A STRING.
   *
   * Because the completeness test below matches these against `mutations.ts`'s exported VALUES by
   * identity. A name written out here would be a third copy of the same list — the export, the
   * import at the top of this file, and a string — and a factory renamed at the source would leave
   * a case pointing at a name nothing exports, which is the failure mode this whole file is about.
   */
  factory: (queryClient: QueryClient) => unknown;
  variables: unknown;
}[] = [
  {
    name: "granting a plugin to a Bot",
    route: "POST /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    factory: setPluginGrantMutationOptions,
    variables: {
      agentId: "bot-1",
      granted: true,
      kind: "mcp" as const,
      ref: "linear/create_issue",
    },
  },
  {
    name: "withholding a plugin from a Bot",
    route: "DELETE /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    factory: setPluginGrantMutationOptions,
    variables: {
      agentId: "bot-1",
      granted: false,
      kind: "mcp" as const,
      ref: "linear/create_issue",
    },
  },
  {
    name: "adding a curated server",
    route: "POST /api/plugins/servers",
    status: 409,
    message: "That server was added but its tools could not be read.",
    factory: addCuratedServerMutationOptions,
    variables: { key: "linear" },
  },
  {
    name: "adding a server by URL",
    route: "POST /api/plugins/servers/custom",
    status: 409,
    message: "That server was added but its tools could not be read.",
    factory: addCustomServerMutationOptions,
    variables: {
      id: "in-house",
      title: "In house",
      url: "https://example.invalid/mcp",
    },
  },
  {
    name: "enabling a Composio app",
    route: "POST /api/plugins/composio/apps",
    status: 409,
    message:
      "The app was added, but its tools could not be read just now. Press Refresh on the Plugins page.",
    factory: enableComposioAppMutationOptions,
    variables: { slug: "linear" },
  },
  {
    name: "refreshing a server's tools",
    route: "POST /api/plugins/servers/:id/refresh",
    status: 409,
    message: "That server's tools could not be recorded.",
    factory: refreshPluginServerMutationOptions,
    variables: "linear",
  },
  {
    name: "removing a server",
    route: "DELETE /api/plugins/servers/:id",
    status: 409,
    message: "That server could not be removed.",
    factory: removePluginServerMutationOptions,
    variables: "linear",
  },
  {
    name: "saving a skill",
    route: "POST /api/plugins/skills",
    status: 500,
    message: "The skill could not be saved.",
    factory: saveSkillMutationOptions,
    variables: {
      instructions: "Do the thing.",
      slug: "triage",
      title: "Triage",
      tools: [],
    },
  },
  {
    name: "removing a skill",
    route: "DELETE /api/plugins/skills/:slug",
    status: 500,
    message: "That did not work.",
    factory: removeSkillMutationOptions,
    variables: "triage",
  },
  {
    name: "registering an OAuth client",
    route: "POST /api/plugins/servers/:id/oauth-client",
    status: 409,
    message: "That OAuth client could not be registered.",
    factory: registerOAuthClientMutationOptions,
    variables: {
      clientId: "abc",
      clientSecret: "shh",
      serverId: "linear",
    },
  },
  {
    name: "confirming a brokered connection",
    route: "POST /api/plugins/servers/:id/connection/confirm",
    status: 502,
    message: "Composio would not say whether this account is connected.",
    factory: confirmBrokeredConnectionMutationOptions,
    variables: "gmail",
  },
  {
    name: "disconnecting a brokered account",
    route: "DELETE /api/plugins/servers/:id/connection",
    status: 502,
    message: "Composio would not end this account, and gave no reason.",
    factory: disconnectBrokeredMutationOptions,
    variables: "gmail",
  },
  {
    name: "handing over a typed key",
    route: "POST /api/plugins/servers/:id/connect",
    status: 400,
    message:
      "What you entered for gmail did not work, and Composio would not take the account back either. Disconnect it on the Plugins page and try again.",
    factory: connectBrokeredWithFieldsMutationOptions,
    variables: {
      serverId: "gmail",
      values: { api_key: "wrong" },
    },
  },
  {
    name: "re-checking a key",
    route: "POST /api/plugins/servers/:id/connection/recheck",
    status: 400,
    message: "gmail would not answer with the key it is holding.",
    factory: recheckBrokeredConnectionMutationOptions,
    variables: "gmail",
  },
];

for (const refusal of REFUSALS) {
  test(`${refusal.name} refetches the plugin screens even when the write is refused`, async () => {
    refusing(refusal.status, refusal.message);
    expect(
      await refetchedOnRefusal(refusal.factory, refusal.variables),
    ).toEqual(EVERY_PLUGIN_QUERY);
  });
}

test("asking an app what it wants refetches nothing, because it writes nothing", async () => {
  /*
   * THE ONE WRITE-SHAPED PRESS THAT IS NOT A WRITE, and the reason this file does not simply say
   * "every mutation invalidates". The first press on an app whose key somebody types is a question
   * about the APP — `POST /connect` with no body — and the route answers it out of Composio's
   * published field list without touching a row. Nothing changed, so there is nothing to refetch,
   * and a refusal here is the same fact as a success: this deployment now knows no more than it did.
   *
   * Which is also why this factory takes no `QueryClient` at all. The property is structural rather
   * than a decision repeated in a callback: there is no client here to invalidate with.
   */
  refusing(502, "Composio would not say what Gmail asks for.");
  const options = brokeredConnectionFieldsMutationOptions();
  expect("onSuccess" in options).toBe(false);
  expect("onSettled" in options).toBe(false);
  await expect(
    options.mutationFn?.("gmail", mutationContext()),
  ).rejects.toThrow("Composio would not say what Gmail asks for.");
});

/**
 * The exported functions that are NOT a mutation factory at all, each with why.
 *
 * Named rather than filtered out by a rule about their shape, because "it does not look like a
 * mutation factory" is precisely the judgement that let a real one go uncovered: this file had no
 * case for `connectAccountMutationOptions` for two rounds and nothing anywhere said so.
 */
const NOT_A_MUTATION_FACTORY: Record<string, string> = {
  invalidatePlugins:
    "The refetch itself — the thing every case above asserts was asked for, not a press.",
  grantPlugin:
    "The bare write, for a caller granting a batch and refreshing once at the end. It carries no refetch on purpose, and the mutation that wraps it is covered above.",
};

/**
 * The mutation factories the property above does not apply to, each with why it does not.
 *
 * AN EXEMPTION IS A CLAIM AND IT IS WRITTEN DOWN AS ONE. Both of these are structural rather than a
 * decision somebody made in a callback — neither factory has a `QueryClient` to invalidate with —
 * so an exemption here can be checked against the code rather than taken on trust, and a factory
 * that grows a client later stops qualifying and has to move into `REFUSALS`.
 */
const NOT_A_REFUSABLE_WRITE: Record<string, string> = {
  brokeredConnectionFieldsMutationOptions:
    "Asks an app what it wants typed in. `POST /connect` with no body writes nothing on either outcome, and the factory takes no QueryClient. Its own test is above.",
  connectAccountMutationOptions:
    "Starts a consent connection and hands back the vendor's URL for the browser to leave for. Nothing on this screen survives that navigation to be refetched, and this factory takes no QueryClient either — it takes which screen to come back to.",
};

test("every mutation factory `mutations.ts` exports is answered for by this file", () => {
  /*
   * THE COMPLETENESS CHECK, AND THE REASON THIS FILE NEEDED ONE. Both sibling drift tests count
   * their roster against the declaration it mirrors; this one counted nothing, so a fifteenth
   * factory added to `mutations.ts` with `onSuccess` where `onSettled` belongs was a case nobody
   * wrote and nobody missed. Adding the count is what turned up `connectAccountMutationOptions`,
   * which had been exported and unanswered-for the whole time.
   *
   * READ OFF THE MODULE'S RUNTIME EXPORTS, not off a list of names in this file. A namespace import
   * is the one thing here that cannot fall behind the source: a factory added, renamed or deleted
   * changes this list on the next run. Every exported function has to land in exactly one of three
   * places — a refusal case, a declared exemption, or a declared non-factory — and membership of
   * the first is matched BY VALUE, so a rename cannot leave a case pointing at a ghost.
   *
   * `typeof value === "function"` is the whole of the filter DELIBERATELY, rather than a name
   * ending in `MutationOptions`. The types this module exports are erased and never reach here, so
   * the filter costs nothing; a factory named something else entirely still shows up, which a
   * suffix rule would have let through — and a suffix rule is a convention, which is the kind of
   * thing the next file breaks without noticing.
   */
  const exported = Object.entries(pluginMutations)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();

  const covered = new Set<unknown>(REFUSALS.map((refusal) => refusal.factory));
  const answeredFor = Object.entries(pluginMutations)
    .filter(
      ([name, value]) =>
        typeof value === "function" &&
        (covered.has(value) ||
          name in NOT_A_REFUSABLE_WRITE ||
          name in NOT_A_MUTATION_FACTORY),
    )
    .map(([name]) => name)
    .sort();

  expect(answeredFor).toEqual(exported);

  /*
   * AND NEITHER EXEMPTION LIST OUTLIVES WHAT IT EXEMPTS. An entry naming a function this module no
   * longer exports, or one a refusal case now covers, is a claim about nothing — and a stale
   * exemption is how a roster goes on looking complete while the thing it excused was quietly
   * replaced by something that does need a case.
   */
  const unclaimed = exported.filter(
    (name) => !covered.has((pluginMutations as Record<string, unknown>)[name]),
  );
  expect(
    [
      ...Object.keys(NOT_A_REFUSABLE_WRITE),
      ...Object.keys(NOT_A_MUTATION_FACTORY),
    ].sort(),
  ).toEqual(unclaimed);
});
