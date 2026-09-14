import { afterEach, expect, test } from "bun:test";
import {
  type MutationFunctionContext,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query";
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
  run: () => Promise<unknown[]>;
}[] = [
  {
    name: "granting a plugin to a Bot",
    route: "POST /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    run: () =>
      refetchedOnRefusal(setPluginGrantMutationOptions, {
        agentId: "bot-1",
        granted: true,
        kind: "mcp" as const,
        ref: "linear/create_issue",
      }),
  },
  {
    name: "withholding a plugin from a Bot",
    route: "DELETE /api/plugins/grants",
    status: 500,
    message: "That Agent could not be changed.",
    run: () =>
      refetchedOnRefusal(setPluginGrantMutationOptions, {
        agentId: "bot-1",
        granted: false,
        kind: "mcp" as const,
        ref: "linear/create_issue",
      }),
  },
  {
    name: "adding a curated server",
    route: "POST /api/plugins/servers",
    status: 409,
    message: "That server was added but its tools could not be read.",
    run: () =>
      refetchedOnRefusal(addCuratedServerMutationOptions, { key: "linear" }),
  },
  {
    name: "adding a server by URL",
    route: "POST /api/plugins/servers/custom",
    status: 409,
    message: "That server was added but its tools could not be read.",
    run: () =>
      refetchedOnRefusal(addCustomServerMutationOptions, {
        id: "in-house",
        title: "In house",
        url: "https://example.invalid/mcp",
      }),
  },
  {
    name: "enabling a Composio app",
    route: "POST /api/plugins/composio/apps",
    status: 409,
    message:
      "The app was added, but its tools could not be read just now. Press Refresh on the Plugins page.",
    run: () =>
      refetchedOnRefusal(enableComposioAppMutationOptions, { slug: "linear" }),
  },
  {
    name: "refreshing a server's tools",
    route: "POST /api/plugins/servers/:id/refresh",
    status: 409,
    message: "That server's tools could not be recorded.",
    run: () => refetchedOnRefusal(refreshPluginServerMutationOptions, "linear"),
  },
  {
    name: "removing a server",
    route: "DELETE /api/plugins/servers/:id",
    status: 409,
    message: "That server could not be removed.",
    run: () => refetchedOnRefusal(removePluginServerMutationOptions, "linear"),
  },
  {
    name: "saving a skill",
    route: "POST /api/plugins/skills",
    status: 500,
    message: "The skill could not be saved.",
    run: () =>
      refetchedOnRefusal(saveSkillMutationOptions, {
        instructions: "Do the thing.",
        slug: "triage",
        title: "Triage",
        tools: [],
      }),
  },
  {
    name: "removing a skill",
    route: "DELETE /api/plugins/skills/:slug",
    status: 500,
    message: "That did not work.",
    run: () => refetchedOnRefusal(removeSkillMutationOptions, "triage"),
  },
  {
    name: "registering an OAuth client",
    route: "POST /api/plugins/servers/:id/oauth-client",
    status: 409,
    message: "That OAuth client could not be registered.",
    run: () =>
      refetchedOnRefusal(registerOAuthClientMutationOptions, {
        clientId: "abc",
        clientSecret: "shh",
        serverId: "linear",
      }),
  },
  {
    name: "confirming a brokered connection",
    route: "POST /api/plugins/servers/:id/connection/confirm",
    status: 502,
    message: "Composio would not say whether this account is connected.",
    run: () =>
      refetchedOnRefusal(confirmBrokeredConnectionMutationOptions, "gmail"),
  },
  {
    name: "disconnecting a brokered account",
    route: "DELETE /api/plugins/servers/:id/connection",
    status: 502,
    message: "Composio would not end this account, and gave no reason.",
    run: () => refetchedOnRefusal(disconnectBrokeredMutationOptions, "gmail"),
  },
  {
    name: "handing over a typed key",
    route: "POST /api/plugins/servers/:id/connect",
    status: 400,
    message:
      "What you entered for gmail did not work, and Composio would not take the account back either. Disconnect it on the Plugins page and try again.",
    run: () =>
      refetchedOnRefusal(connectBrokeredWithFieldsMutationOptions, {
        serverId: "gmail",
        values: { api_key: "wrong" },
      }),
  },
  {
    name: "re-checking a key",
    route: "POST /api/plugins/servers/:id/connection/recheck",
    status: 400,
    message: "gmail would not answer with the key it is holding.",
    run: () =>
      refetchedOnRefusal(recheckBrokeredConnectionMutationOptions, "gmail"),
  },
];

for (const refusal of REFUSALS) {
  test(`${refusal.name} refetches the plugin screens even when the write is refused`, async () => {
    refusing(refusal.status, refusal.message);
    expect(await refusal.run()).toEqual(EVERY_PLUGIN_QUERY);
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
