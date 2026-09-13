import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { pluginKeys } from "./queries";

/**
 * Writes against what a deployment has installed: MCP servers, skills, and which Bots carry them.
 *
 * Servers and skills are two kinds of the same thing here — a plugin the deployment holds and grants
 * — which is why one grant endpoint serves both and takes the kind as an argument rather than having
 * two of everything.
 */

/** A skill as the server accepts it. `global` is an administrator writing for everybody. */
export type SkillInput = {
  slug: string;
  title: string;
  summary?: string;
  instructions: string;
  global?: boolean;
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * Sent on every save, including empty, because the server replaces the set rather than merging
   * into it: omitting the field to mean "leave them alone" and sending `[]` to mean "clear them"
   * would be the same request from a form that just had its last one unticked.
   */
  tools?: string[];
};

/** A curated server from the catalogue, which supplies the URL. */
export type CuratedServerInput = {
  key: string;
  instanceHost?: string;
  credentialId?: string;
};

/**
 * A server somebody typed the URL of, which therefore has to pass the URL checks.
 *
 * `token` is carried through as the previous version did. It is already a credential by the time
 * this is sent — the id beside it is what the record keeps — so the server has no use for it.
 */
export type CustomServerInput = {
  id: string;
  title: string;
  url: string;
  token?: string;
  credentialId?: string;
};

/** Which kinds of plugin a grant can be about. */
export type PluginKind = "mcp" | "skill";

const FALLBACK = "That did not work.";

/**
 * Refetch everything the plugin screens read.
 *
 * Exported because a bulk grant has to say when: N of these in a row, each awaiting its own
 * refetch, is a dialog that spends most of a batch re-reading a list nobody has looked at yet.
 */
export function invalidatePlugins(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.all });
}

/**
 * Grant one plugin to one Bot, and refetch nothing.
 *
 * The write on its own, for the caller granting a batch of them: the server still records a row per
 * grant, so the audit trail is unchanged, but the reader is refreshed once at the end rather than
 * between every pair. Anything granting a single one should use the mutation below instead, which
 * carries the refetch with it.
 */
export function grantPlugin(variables: {
  kind: PluginKind;
  ref: string;
  agentId: string;
}): Promise<unknown> {
  return client("/api/plugins/grants", {
    method: "POST",
    body: {
      kind: variables.kind,
      ref: variables.ref,
      agentId: variables.agentId,
    },
    fallback: "That Agent could not be changed.",
  });
}

/**
 * Whether one Bot carries one plugin.
 *
 * Granting posts to the collection; withholding deletes from it, and the delete identifies the row
 * by query string because a grant has no id of its own — it is the three things it joins.
 */
export function setPluginGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      kind: PluginKind;
      ref: string;
      agentId: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await grantPlugin(variables);
        return;
      }
      await client(
        `/api/plugins/grants?kind=${variables.kind}&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: "That Agent could not be changed." },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function addCuratedServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CuratedServerInput) => {
      await client("/api/plugins/servers", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function addCustomServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CustomServerInput) => {
      await client("/api/plugins/servers/custom", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Add a Composio app to the deployment, named by its slug.
 *
 * Its own endpoint rather than a curated key, because the catalogue is the vendor's rather than
 * ours: the slug is all the server needs to look the app up and record the row.
 */
export function enableComposioAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { slug: string }) => {
      await client("/api/plugins/composio/apps", {
        method: "POST",
        body: input,
        fallback: "That app could not be added.",
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/** Re-read a server's tool list, which is what makes a newly-added tool appear. */
export function refreshPluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${serverId}/refresh`, {
        method: "POST",
        body: {},
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function removePluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Write a skill, or rewrite one.
 *
 * One endpoint for both: the slug is the identity, so posting an existing one replaces it. The
 * fallback names saving rather than creating for that reason.
 */
export function saveSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: SkillInput): Promise<unknown> =>
      client("/api/plugins/skills", {
        method: "POST",
        body: input,
        /*
         * The server refuses for reasons a form cannot check — a slug somebody else already owns is
         * the common one — and paraphrasing that would throw away the only part worth reading.
         */
        fallback: "The skill could not be saved.",
      }),
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/** The deployment's OAuth client for a vendor reached as the person asking. */
export type OAuthClientInput = {
  serverId: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Register the deployment's OAuth client for a `user-oauth` server.
 *
 * Its own write rather than a field on the curated-server input, because it has its own lifetime: a
 * client is rotated without the server being re-added, and re-adding a server should not mean
 * re-typing a client. It is also recorded against the server row, so it can only happen once that
 * row exists — which is why the page chains it rather than sending both at once.
 *
 * Nobody's documents are reachable with what this sends. A client identifies this deployment to the
 * vendor; the grant that reads anything belongs to each person and is made on their own settings page.
 */
export function registerOAuthClientMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: OAuthClientInput) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(input.serverId)}/oauth-client`,
        {
          method: "POST",
          body: { clientId: input.clientId, clientSecret: input.clientSecret },
          fallback: "That OAuth client could not be registered.",
        },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Begin connecting the signed-in person's own account.
 *
 * Answers with the vendor's consent URL rather than navigating, so the caller decides when to leave
 * the page. There is deliberately nothing here that could complete the consent on somebody's behalf.
 */
/**
 * Start a consent flow, and say which screen it started from.
 *
 * `returnTo` decides where the vendor's callback puts somebody down, because two screens offer this:
 * a person's own connected-accounts page, and the connector's admin page where an administrator
 * verifies the setup they have just finished. Sending an administrator to their personal settings
 * afterwards is the round trip the inline row exists to remove.
 *
 * A name rather than a URL. The server narrows it to a known set before signing it into the state,
 * so this parameter cannot become an open redirect however it is called.
 */
export function connectAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: (serverId: string): Promise<string> =>
      client<string>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect?returnTo=${returnTo}`,
        "authorizationUrl",
        { method: "POST", fallback: "That account could not be connected." },
      ),
  });
}

/**
 * Ask the vendor whether a brokered connection actually completed.
 *
 * Exists because the return trip from consent proves nothing. The callback is an ordinary redirect
 * with nothing signed in it, so somebody arriving back on the page is not evidence that they
 * finished the flow — or that the account they finished it with is the one the row claims. So the
 * vendor is asked, and its answer is what the connected state is written from.
 *
 * Answers with the body rather than a bare success, because "asked, and told not connected" is a
 * different thing for a screen to say than "could not ask".
 *
 * There is no start half here: beginning a brokered connect is the same write as any other consent
 * flow, so callers use `connectAccountMutationOptions` above, which already reads the vendor's
 * `authorizationUrl` off the connect route.
 */
export function confirmBrokeredConnectionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<{ connected: boolean }> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/confirm`,
        { method: "POST", fallback: "That connection could not be confirmed." },
      );
      return (await response.json()) as { connected: boolean };
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * End the signed-in person's brokered connection.
 *
 * Ends the account at Composio rather than only here. Forgetting the row on our side would leave
 * the vendor still holding a live grant on somebody's mailbox, which is not what the person who
 * pressed disconnect was told would happen.
 */
export function disconnectBrokeredMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection`,
        {
          method: "DELETE",
          fallback: "That account could not be disconnected.",
        },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function removeSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(`/api/plugins/skills/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * One value Composio wants from the person connecting, as Composio itself describes it.
 *
 * Declared here rather than guessed at a form: the vendor publishes the list per app, `secret` says
 * which one to mask, and `help` is written for the person filling it in. `name` goes back on the
 * wire verbatim and is never shown.
 */
export type BrokerField = {
  name: string;
  label: string;
  help: string;
  required: boolean;
  secret: boolean;
  default?: string;
};

/**
 * Ask what an app wants typed in, for the apps nobody consents to.
 *
 * Most Composio apps are not connected through a consent screen — the person holds an API key and
 * types it in — so the same connect route answers a field list on the first press and takes the
 * values on the second. Nothing is written by this half: it is a question about the app, not about
 * anybody's account, which is why it refetches nothing.
 */
export function brokeredConnectionFieldsMutationOptions() {
  return mutationOptions({
    mutationFn: (serverId: string): Promise<BrokerField[]> =>
      client<BrokerField[]>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect`,
        "fields",
        {
          method: "POST",
          fallback: "That app could not be asked what it needs.",
        },
      ),
  });
}

/**
 * Finish that connection with what the person typed.
 *
 * The values are passed to the mutation and held nowhere else — no query cache, no router state, no
 * local storage. They are somebody's own key: the request body is the whole of their life in this
 * app, and putting them anywhere a later render could read them back would be keeping a credential
 * we were only ever asked to forward.
 *
 * Answers with the body rather than a bare success, because Composio does not check a submitted key.
 * `connected` is only that the vendor accepted the row; `verified` is whether a real call was made
 * with it, and a screen says different things about the two.
 */
export function connectBrokeredWithFieldsMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      values: Record<string, string>;
    }): Promise<{ connected: boolean; verified: boolean }> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(variables.serverId)}/connect`,
        {
          method: "POST",
          body: { values: variables.values },
          fallback: "That account could not be connected.",
        },
      );
      return (await response.json()) as {
        connected: boolean;
        verified: boolean;
      };
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Spend one read-only call at the vendor to find out whether a key still works.
 *
 * A button rather than something a page does on its own. Verifying on every render would spend the
 * person's own rate limit at the vendor to redraw a word, so the check happens when somebody asks
 * for it and the answer is recorded with the time it was taken.
 */
export function recheckBrokeredConnectionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      serverId: string,
    ): Promise<{ verified: boolean; verifiedAt: string | null }> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/recheck`,
        { method: "POST", fallback: "That connection could not be checked." },
      );
      return (await response.json()) as {
        verified: boolean;
        verifiedAt: string | null;
      };
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}
