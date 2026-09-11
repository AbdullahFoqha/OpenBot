import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  type BrokerApp,
  BrokerUnconfiguredError,
  brokerSentence,
  type ComposioBroker,
} from "./broker";
import { CATALOGUE, catalogueEntry } from "./catalogue";
import { toolkitOf, vendorSentence } from "./composio";
import {
  authorizationUrlFor,
  type ConnectOrigin,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  sealConnectState,
} from "./oauth";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
  type OAuthClient,
  type PluginKind,
  PluginRefusedError,
  type PluginStore,
} from "./store";

/**
 * Whether the person a consent was started for still has access to this deployment.
 *
 * A seam rather than an import, because these routes have no business knowing what a person is or
 * where the deny list lives — and because the answer has to come from the deployment as it is when
 * the callback lands, not from what was true when the flow started.
 *
 * False for somebody who was removed while they were away at the vendor's consent screen, and false
 * for a user id that names nobody at all. Both are the same refusal: there is no live person for
 * this grant to belong to.
 */
export type ConnectingPersonCheck = (userId: string) => Promise<boolean>;

/**
 * What somebody is told when the broker itself failed, and what is deliberately kept out of it.
 *
 * EVERY BROKERED ROUTE NEEDS THIS AND NONE OF THEM USED TO HAVE IT. A listing, a connect, a confirm
 * and a disconnect all end in a call to another company's API, and an unhandled rejection out of any
 * of them is a bare 500 with the vendor's thrown object on this deployment's console. That object is
 * the whole HTTP response — headers, trace ids, rate-limit counters — and the person reading the 500
 * gets none of it and no sentence either. A wrong `COMPOSIO_API_KEY` is the first failure a new
 * operator meets, and it is the one this used to answer worst.
 *
 * `vendorSentence` IS THE SAME ONE THE TRANSPORT USES, for the same reason it exists there: the
 * useful sentence — "Invalid API key", "No connected account found for user …" — is nested two
 * levels inside `cause` beside everything that must not be shown, so this reaches in for that one
 * string and takes nothing else. Null from it is a failure this deployment cannot explain, and the
 * caller's own generic sentence is what a reader gets instead of the vendor's placeholder.
 *
 * NOTHING FROM THE REQUEST OR THE ANSWER TRAVELS WITH IT. Not the API key, which never leaves the
 * adapter; not a connect link, which is a bearer capability handed to one browser; and not the
 * thrown object, whether by spreading it, stringifying it or logging it.
 *
 * 502 RATHER THAN 500, because nothing here broke: this deployment asked a third party and the third
 * party did not answer usefully, which is the same reading the dynamic-registration failure below
 * already gives. {@link BrokerUnconfiguredError} is the one exception and keeps the 503 every other
 * no-broker answer on these routes uses — nobody was asked at all, and the remedy is one environment
 * variable long.
 */
function brokerRefusal(
  error: unknown,
  generic: string,
): { error: string; status: 502 | 503 } {
  const unconfigured = brokerSentence(error);
  if (unconfigured) return { error: unconfigured, status: 503 };
  return { error: vendorSentence(error) ?? generic, status: 502 };
}

/**
 * What a reader is told when Composio would not answer with its directory.
 *
 * One constant because two routes make that call — browsing the catalogue and enabling an app out of
 * it — and a reader meeting the same failure through two doors should not meet two sentences. It
 * names the setting rather than quoting it: a key that was pasted with a space in it, or one for
 * another project, is the likeliest reason Composio will not talk to this deployment at all.
 */
const DIRECTORY_UNAVAILABLE =
  "Composio would not answer with its app directory, and said nothing about why. Check that COMPOSIO_API_KEY is this project's key, and check Composio's status if it persists.";

/**
 * The Plugins surface: what this deployment has added, and which Bots may use it.
 *
 * What a Bot can reach is an administrator's; what it is told is not. Adding an MCP server stores a
 * credential and opens a path into another company's system, and enabling one on a Bot is the same
 * decision one step later, so both are an administrator's. A skill only ever asks for tools the Bot
 * already holds, and every one of those calls is still decided, policy-checked and audited, so
 * anybody may write one for themselves and put it on a Bot they own.
 *
 * Reading is open to any signed-in person either way: what a Bot can reach is not a secret from the
 * person talking to it.
 *
 * The call endpoint asks again. The list of tools a run was offered is a snapshot taken when the run
 * started, so a grant revoked a second later is still in the model's hands. Deciding at call time is
 * what makes revocation immediate rather than nearly immediate, and it is where a refusal becomes a
 * row somebody can read.
 */
export function createPluginRoutes(
  store: PluginStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot they named. Required rather than optional, so a deployment
   * cannot end up calling somebody else's tools by leaving an argument off.
   */
  canUseBot: BotAccessCheck,
  /**
   * What the connect flow needs that the store does not hold: the key its state is sealed with, the
   * address a vendor sends people back to, and who still has access when they come back.
   *
   * Optional, so a deployment with no public URL configured simply cannot start a connect flow and
   * says so, rather than building a redirect URI out of a request header and failing at the vendor.
   *
   * Last, and after every required parameter, because that is the only position an optional argument
   * can hold. Both of these arrived on separate branches as "one more parameter", which is how a
   * positional list becomes a trap: every argument from here on is optional, so a misplaced one
   * typechecks and simply does nothing.
   */
  connect?: {
    encryptionKey: string;
    /**
     * Whether the person a state names may still connect an account here.
     *
     * Required rather than optional, unlike everything else that arrived on this object as "one more
     * parameter". The callback is sessionless on purpose, so this is the ONLY thing asking whether
     * the identity in the state is still one this deployment recognises — and a deployment that
     * forgot to pass it would complete a consent for somebody who was removed ten minutes ago and
     * write a live refresh token nothing will ever revoke.
     */
    personHasAccess: ConnectingPersonCheck;
    /**
     * Whether this deployment holds a shared secret a Bot may present when calling a tool back.
     *
     * A boolean about configuration, never the secret. Without it, a Bot can only call back if it
     * holds a credential issued to it alone, and a Bot with neither is refused before the call ever
     * reaches the grant, the boundary or the trail. The Bots screen needs this to stop promising a
     * grant the deployment cannot honour.
     */
    botsMayCallBack?: boolean;
    publicUrl: string | undefined;
    /**
     * Where the app is, which is not where this API is.
     *
     * The callback lands here and has to send the person back to a page. A relative redirect would
     * put them on this server's origin, which locally is a Vite-less port that serves no pages at
     * all — so the flow would complete correctly and end on a 404.
     */
    appUrl: string | undefined;
  },
  /**
   * The broker this deployment talks to when an app is connected for somebody rather than
   * registered by an administrator.
   *
   * Its own parameter rather than a field on `connect`, because nothing on that object applies
   * here. `connect` is the OAuth consent flow this deployment runs itself: the key its state is
   * sealed with, the redirect URI a vendor sends people back to, the access check the sessionless
   * callback asks. A brokered app uses none of it — the vendor holds the consent, so there is no
   * state to seal, no callback to land here and no redirect URI to publish. Folding it in would put
   * a field on an object whose every other field is about a flow it never enters.
   *
   * Optional, and last for the same reason `connect` is: a deployment with no Composio API key
   * configured simply has no broker, and the surface says so rather than pretending one exists. The
   * trap `connect` documents applies here with one more argument in it — every parameter from that
   * position on is optional, so a misplaced one typechecks and quietly does nothing.
   */
  composio?: { broker: ComposioBroker },
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  const skillActor = (context: { var: AppVariables }) => ({
    id: context.var.actor.id,
    isAdmin: context.var.actor.role === "admin",
  });

  /**
   * May this person write, edit or delete this skill?
   *
   * An administrator may touch anything. Everybody else may touch their own and nothing else, which
   * includes not editing a deployment skill an administrator wrote for everyone.
   */
  async function skillRefusal(
    context: { var: AppVariables },
    slug: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    const owner = await store.skillOwner(slug);
    if (owner === undefined) return null; // A new skill. Ownership is decided on the way in.
    if (owner === null) {
      return `${slug} belongs to this deployment. An administrator looks after it.`;
    }
    return owner === actor.id ? null : `${slug} is somebody else's skill.`;
  }

  /** Everything the Plugins page draws: the catalogue, what is added, and the skills. */
  routes.get("/", requireUser, async (context) =>
    context.json({
      catalogue: CATALOGUE.map((entry) => ({
        key: entry.key,
        title: entry.title,
        vendor: entry.vendor,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /*
         * The kind, not the whole thing. The page needs to know what to ask an administrator for;
         * it has no use for the vendor's OAuth addresses, and a URL this deployment sends an
         * authorization code to is not improved by also existing in every browser that opens the
         * Plugins page.
         */
        auth: entry.auth.kind,
        perInstance: entry.host === null,
      })),
      /*
       * Whether a Bot with no credential of its own can still call a tool back.
       *
       * The grant switch decides whether a tool is offered to a model; this decides whether any
       * call it makes can be authenticated at all. They are different questions and the screen used
       * to answer only the first, so a grant could read "May call this tool" on a deployment where
       * every call was refused before it reached the boundary.
       */
      botsMayCallBack: connect?.botsMayCallBack === true,
      /*
       * Whether this deployment has a broker at all, so the page knows whether brokered apps are
       * on offer.
       *
       * A boolean about configuration, never the key. The API key that builds the broker is a
       * deployment credential and the Plugins page is reachable by any signed-in person; what the
       * screen needs is whether to draw the app directory, which is a yes or a no.
       */
      composioConfigured: Boolean(composio),
      servers: await store.listServers(),
      // Scoped: the deployment's skills plus this person's own. An administrator sees them all.
      skills: await store.listSkills(skillActor(context)),
      /*
       * What an administrator has to register with the vendor, character for character.
       *
       * Served rather than assembled in the browser, so what is displayed is exactly what the
       * callback will present. A mismatch here fails at the vendor with a message that does not name
       * us, which is a bad afternoon for whoever is setting it up.
       *
       * Null means this deployment has no public URL, so it cannot complete a consent flow at all.
       */
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    }),
  );

  /** Add a curated server. The URL comes from the catalogue, never from the request. */
  routes.post("/servers", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      key?: string;
      instanceHost?: string;
      credentialId?: string;
    } | null;
    if (!body?.key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }

    try {
      const server = await store.addServer({
        key: body.key,
        instanceHost: body.instanceHost,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      // A refused credential is the administrator's mistake to correct, so it comes back as a
      // refusal with its reason rather than as a 500 the way an unmapped throw would.
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      /*
       * The same mapping the refresh route makes, on the routes that call the same method.
       *
       * CRITERION. Every admin route whose store call can reach a fault on the
       * `isDeploymentFault` shelf answers with the sentence rather than leaving it to the default
       * handler.
       *
       * REASON. Adding a server REFRESHES it before answering — deliberately, so a bad credential
       * is reported now rather than the first time a Bot uses it — so every fault `refreshTools`
       * raises arrives here too, and a vendor listing one action twice or a query of ours failing
       * is exactly that. Mapped on one route and not on its siblings, the same fault is a named
       * sentence or "That did not work" depending on which button was pressed, which is the shape
       * that made this class hard to see the first time.
       */
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Add a server by URL.
   *
   * Its own endpoint rather than a flag on the one above, so that "an administrator pointed this
   * deployment at an address of their own" is a distinct act in the code, in the audit trail and in
   * anything that reads either.
   */
  routes.post("/servers/custom", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      url?: string;
      credentialId?: string;
    } | null;
    if (!body?.id?.trim() || !body?.title?.trim() || !body?.url?.trim()) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id.trim(),
        title: body.title.trim(),
        url: body.url.trim(),
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // As on the curated add above, and for the same reason: this path refreshes before it
      // answers.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Register this deployment's OAuth client for a server reached as the person asking.
   *
   * Its own endpoint rather than a field on `POST /servers`, because it is a separate act with a
   * separate lifetime: a client is rotated without the server being re-added, and re-adding a server
   * should not require re-typing a client. An administrator's, like everything else that decides what
   * a Bot can reach.
   */
  routes.post("/servers/:id/oauth-client", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (!body?.clientId?.trim() || !body.clientSecret?.trim()) {
      return context.json(
        { error: "A client id and a client secret are both required." },
        400,
      );
    }

    try {
      await store.registerOAuthClient({
        serverId: context.req.param("id"),
        client: {
          clientId: body.clientId.trim(),
          clientSecret: body.clientSecret.trim(),
        },
        by: actorEmail(context),
      });
      return context.json({ ok: true });
    } catch (error) {
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // Registering a client resolves the row first, so a row this deployment cannot say how to
      // reach refuses here as well.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  routes.delete("/servers/:id", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    await store.removeServer(context.req.param("id"), actorEmail(context));
    return context.json({ ok: true });
  });

  /** Ask a server what it offers now. Reported rather than thrown, so the page can say what broke. */
  routes.post("/servers/:id/refresh", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      const result = await store.refreshTools(
        context.req.param("id"),
        context.var.actor.id,
      );
      const servers = await store.listServers();
      return context.json({
        tools: result.tools,
        server: servers.find((server) => server.id === context.req.param("id")),
      });
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * The one audience the sentence was written for, and the only route that may show it.
       *
       * CRITERION. A contradiction between this deployment's own columns comes back to an
       * administrator as itself: a body, naming the row and what to do about it.
       *
       * REASON. Unmapped, it reached the framework's default handler — a 500 with no JSON at all,
       * which the admin page reads as "That did not work", the fallback it uses when a response
       * carries no message. So the one refusal that names exactly which row is wrong and how to
       * correct it was the one an operator could not see, while the same sentence WAS reaching a
       * model on the tool-call path. This route is `requireAdmin`, which is what makes showing it
       * here safe and showing it anywhere else not.
       *
       * 409 rather than 500: nothing broke, and nothing about the request was malformed. Two rows
       * of ours disagree, and the request cannot be answered until one of them changes — which is
       * what the sentence tells the reader to go and do.
       */
      if (isDeploymentFault(error)) {
        // `deploymentFaultSentence` rather than `error.message`: the shelf now includes a query
        // this database refused, and that one's message is the statement and every value bound to
        // it. An administrator is entitled to the reason, not to the dump.
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * The broker's catalogue, as an administrator chooses an app out of it.
   *
   * THE SEARCH IS OURS, AND HAS TO BE. `@composio/core`'s toolkit listing forwards category,
   * managed_by, sort_by, cursor and limit, and takes no search term at all — a term handed to it is
   * dropped without a word, and what comes back is an unfiltered first page that looks exactly like
   * a result. So the whole directory is read and filtered in this process, over the three fields an
   * administrator would actually be typing at: the slug, the name and the description. A few
   * hundred rows is a list, not a query.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, not an empty list. An empty directory and an absent one
   * are different facts: the first says Composio has nothing to offer, the second says nobody was
   * asked. Answered as `{ apps: [] }`, a deployment with no key draws "no apps available" over a
   * remedy that is one environment variable long, which is why
   * {@link BrokerUnconfiguredError}'s own message is what is sent rather than a sentence written
   * here.
   *
   * `enabled` comes off `toolkitOf(url)` and never off the row's id. The url is where the
   * transport reads which app a call is against, so it is the only reading that decides anything;
   * the id names the row — `composio-linear` — and reading one as the other would quietly work
   * until somebody renamed a row. `serverUrls` hands over the urls and nothing else, which is that
   * property made structural: there is no id here to read by mistake.
   */
  routes.get("/composio/apps", requireUser, async (context) => {
    /*
     * INSIDE THE HANDLER, and the response returned. `requireAdmin` is a function that answers a
     * response, not Hono middleware: put in the middleware position it typechecks against Hono's
     * variadic signature, runs, and gates nothing at all, because nobody reads what it returned.
     */
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    let directory: BrokerApp[];
    try {
      directory = await composio.broker.listApps();
    } catch (error) {
      // The vendor's own sentence where there is one, because "invalid api key" is the diagnosis
      // and a 500 is not. See {@link brokerRefusal} for what is kept out of the answer.
      const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
      return context.json({ error: refusal.error }, refusal.status);
    }
    const term = (context.req.query("q") ?? "").trim().toLowerCase();
    const matched = term
      ? directory.filter((app) =>
          [app.slug, app.name, app.description].some((field) =>
            field.toLowerCase().includes(term),
          ),
        )
      : directory;

    const enabled = new Set(
      (await store.serverUrls())
        .map((url) => toolkitOf(url))
        .filter((toolkit): toolkit is string => toolkit !== null),
    );
    return context.json({
      apps: matched.map((app) => ({ ...app, enabled: enabled.has(app.slug) })),
    });
  });

  /**
   * Enable one app of that catalogue, which is a third way for a server to arrive.
   *
   * THE SLUG VALIDATION IS THE WHOLE ROUTE. `addBrokeredApp` composes `composio://<slug>`, and that
   * url is what every future call for the app is resolved against — so a slug the directory never
   * answered with is a row pointing at an app that does not exist: added, grantable, enabled on a
   * Bot, and dead at the first call, with nothing on the page saying so. The live directory is what
   * it is checked against rather than a pattern, because the question is not whether the text is
   * well formed but whether Composio has such an app right now.
   *
   * The title comes off the directory entry too. The caller chose an app; they did not choose a
   * name for it.
   */
  routes.post("/composio/apps", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      slug?: string;
    } | null;
    const slug = body?.slug?.trim();
    let directory: BrokerApp[] = [];
    if (slug) {
      try {
        directory = await composio.broker.listApps();
      } catch (error) {
        /*
         * The same failure the directory route answers, in the same words, because it is the same
         * call. Unhandled it was the worst 500 of the three: an administrator pressing Add on a
         * deployment whose key is wrong was told nothing at all, on the one screen where the key
         * had just been set.
         */
        const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
        return context.json({ error: refusal.error }, refusal.status);
      }
    }
    const app = directory.find((candidate) => candidate.slug === slug);
    if (!app) {
      return context.json(
        {
          error: slug
            ? `${slug} is not an app Composio lists for this deployment.`
            : "An app is required.",
        },
        400,
      );
    }

    try {
      const server = await store.addBrokeredApp({
        slug: app.slug,
        title: app.name,
        by: actorEmail(context),
      });
      return context.json({ server }, 201);
    } catch (error) {
      // The same mapping the add routes above make, for the same reason: a refusal an
      // administrator can correct comes back as itself rather than as a 500.
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof PluginRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // And, as on those routes, enabling refreshes before it answers, so every fault
      // `refreshTools` raises arrives here as well.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Where a person's own connections are, and how to start a new one.
   *
   * Not admin-only, and that is the point: an administrator registers the connector once, and then
   * everybody connects their own account. Somebody can only ever see or start their own.
   */
  routes.get("/connections", requireUser, async (context) => {
    /*
     * BOTH TABLES, ONE LIST, because the person asking has one question.
     *
     * "Am I connected to this?" is the same question whether the grant is a refresh token in this
     * deployment's vault or an account Composio holds on our behalf. Which table a connection lives
     * in is a fact about how the vendor is reached — the transport, the credential, who keeps the
     * secret — and none of that is something a settings page should have to know in order to draw a
     * word beside a row. Answering out of `connectionsFor` alone left the brokered half invisible,
     * so the page could only either say "Not connected" over a live account or say nothing at all,
     * and it chose to say nothing.
     *
     * A brokered row is an ordinary connection — `brokeredConnectionsFor` answers in the shape
     * `connectionsFor` answers, deliberately — so nothing here marks which source a row came from
     * and nothing downstream asks.
     *
     * SORTED, so two requests answer in the same order. Each read is ordered by server id within
     * its own table, and concatenating two sorted lists is not a sorted list. Compared as plain
     * strings rather than by `localeCompare`, because the order only has to be the SAME one every
     * time, and a collation that varies with the deployment's locale is not that.
     */
    const [held, brokered] = await Promise.all([
      store.connectionsFor(context.var.actor.id),
      store.brokeredConnectionsFor(context.var.actor.id),
    ]);
    const connections = [...held, ...brokered].sort((left, right) => {
      if (left.serverId < right.serverId) return -1;
      return left.serverId > right.serverId ? 1 : 0;
    });

    return context.json({
      connections,
      // Shown to an administrator so they can register the client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Begin connecting one person's own account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session, and the person's identity never comes off the callback.
   */
  routes.post("/servers/:id/connect", requireUser, async (context) => {
    const serverId = context.req.param("id");

    /*
     * A BROKERED APP IS ANSWERED HERE AND GOES NO FURTHER DOWN THIS HANDLER.
     *
     * Everything below this branch belongs to the consent flow THIS deployment runs: a public URL
     * to build a redirect URI out of, a catalogue entry naming the vendor's authorization
     * endpoint, an OAuth client an administrator registered, a sealed state the callback reads
     * back. A brokered app has none of it. Composio holds the consent, so no authorization code
     * ever comes back to us, no refresh token is stored here, and no redirect URI of ours is
     * registered with anybody — there is nothing for those checks to be about.
     *
     * WHICH IS WHY THE ORDER IS THE WHOLE POINT AND NOT A TIDINESS. Falling through, a brokered
     * row met `catalogueEntry`, which has never heard of `composio-linear`, and the person
     * pressing Connect was told the app "is not connected as an individual person" — the exact
     * opposite of true about the one kind of row that is ONLY ever connected as an individual
     * person. On a deployment with no `OPENBOT_PUBLIC_URL` it failed one step earlier still,
     * refusing for want of a setting that has no bearing on a flow it does not enter.
     *
     * The app comes off the row's url via `toolkitOf` rather than off its id, for the reason the
     * directory route says: the url is where the transport reads which app a call is against, and
     * the id is a row name that happens to look similar.
     *
     * ONE ROW, BY ID. Every request to this route pays for this read, including the ones that fall
     * through to the OAuth flow below, because the branch cannot be taken until the row is in hand
     * — so what it costs has to be a lookup of three columns rather than the whole plugin surface.
     * `serverAddress` answering `undefined` is an id naming no row, which falls through exactly as
     * a missing row did when this was a `.find`.
     */
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (row && toolkit) {
      if (!composio) {
        return context.json(
          { error: new BrokerUnconfiguredError().message },
          503,
        );
      }

      /*
       * NO APP URL IS A REFUSAL, NOT A LINK WITH NO WAY BACK.
       *
       * The address below is where Composio sends this person once they have consented, and it has
       * to be absolute: the consent screen is on another company's origin, so a relative path
       * resolves against theirs. A deployment that cannot say where its own pages are cannot
       * produce one — and minting the link anyway would leave somebody stranded on Composio's
       * hosted page having just granted access, with no route back to the deployment that asked
       * for it and nothing here knowing it happened.
       *
       * The OAuth flow below refuses for its missing `OPENBOT_PUBLIC_URL` in these same terms and
       * for this same reason. `OPENBOT_APP_URL` is the setting here because the two addresses are
       * genuinely different: the API is one origin and the browser app is another, and it is a
       * page this person is coming back to rather than an endpoint.
       */
      if (!connect?.appUrl) {
        return context.json(
          {
            error:
              "This deployment has no app URL configured, so Composio would have nowhere to send you back to. Set OPENBOT_APP_URL.",
          },
          503,
        );
      }

      /*
       * THE PERSON IS THE SESSION'S, HERE AND IN THE READ ABOVE IT.
       *
       * Nothing in this branch reads a user id out of the body or the query, and that is the
       * property rather than an implementation detail: the link minted below attaches an account
       * to whichever person it names, so a user id a caller could choose would let one POST hang
       * somebody else's mailbox off this deployment. It is the defect the prior art this design
       * follows shipped three separate times, and it is structural here — there is no line that
       * could break it.
       */
      const existing = await store.brokeredConnection({
        toolkit,
        userId: context.var.actor.id,
      });
      if (existing) {
        /*
         * Named with the step to take rather than only refused: a second link would attach a
         * second account behind a row that already says connected, and the way to a new one is
         * through the connection they have.
         *
         * THE APP'S TITLE, NOT THE ROW'S ID. `composio-linear` is this deployment's name for a
         * table row; "Linear" is the name of the thing the person connected and the only one of
         * the two they have ever seen on a screen. An internal key in a sentence addressed to a
         * person is both unhelpful and a small leak of how the rows are keyed.
         */
        return context.json(
          {
            error: `You already have an account connected to ${row.title}. Disconnect it first if you want to connect a different one.`,
          },
          409,
        );
      }

      /*
       * WHERE THE CONSENT COMES BACK TO, BUILT HERE AND NEVER READ OFF THE REQUEST.
       *
       * Composio sends the person to this address when they are done, so whoever chooses it
       * chooses where somebody lands holding a just-completed consent. A url taken from the body,
       * the query or a header would therefore be an open redirect with a consent screen in front
       * of it — the exact thing {@link ConnectOrigin} exists to stop on the OAuth flow below, and
       * it is narrowed here in the same way: the caller may name one of two PAGES, and the origin
       * underneath them is this deployment's configured app URL in both cases.
       *
       * Both pages confirm on load, which is what makes either of them a correct destination: the
       * return trip carries nothing signed, so arriving proves nothing, and the page asks Composio
       * whether the account is really attached before anything here says it is.
       */
      const returnTo: ConnectOrigin =
        context.req.query("returnTo") === "admin" ? "admin" : "settings";

      /*
       * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to this person's
       * connection, so it is answered to the browser that asked and to nothing else: not logged,
       * not audited, not put in an error body. A redirect url in a log line is somebody else's
       * mailbox for as long as it stays valid — which is why the failure below answers with the
       * vendor's sentence and never with what was being minted when it failed.
       */
      let redirectUrl: string;
      try {
        ({ redirectUrl } = await composio.broker.authorize({
          userId: context.var.actor.id,
          toolkit,
          returnUrl: connectedAccountsUrlFor(
            connect.appUrl,
            { serverId },
            returnTo,
          ),
        }));
      } catch (error) {
        const refusal = brokerRefusal(
          error,
          `Composio would not begin a connection to ${row.title}, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.`,
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
      return context.json({ authorizationUrl: redirectUrl });
    }

    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
        },
        503,
      );
    }

    const entry = catalogueEntry(serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        { error: `${serverId} is not connected as an individual person.` },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits
     * for an administrator. Registration lives here, on the one handler that already refuses
     * without OPENBOT_PUBLIC_URL — the redirect URI it registers is guaranteed to exist.
     */
    /*
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     *
     * The same 409 as a vendor whose client an administrator has not pasted in yet, because it is
     * the same situation: the person pressing Connect has no step to take, and an administrator has
     * one. The sentence names the step rather than the exception.
     */
    let client: OAuthClient | null;
    try {
      client =
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
          },
          409,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `${entry.title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin}: a destination that could
     * name another origin is an open redirect with a consent screen in front of it.
     */
    const returnTo =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";

    const verifier = createVerifier();
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(connect.publicUrl),
        state: await sealConnectState(
          { userId: context.var.actor.id, serverId, verifier, returnTo },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * Which app one of the two routes below is about, or the refusal that ends it.
   *
   * Both of them act on a brokered connection and on nothing else, so both ask the same two
   * questions in the same order and answer them in the same words. It is one function because the
   * sentence somebody reads when they aim either route at an ordinary OAuth row should not be able
   * to drift into two sentences.
   *
   * THE APP COMES OFF THE ROW'S URL AND NEVER OFF ITS ID, for the reason the directory route and
   * the connect branch above both give: the url is where the transport reads which app a call is
   * against, and the id is a row name that happens to look similar.
   *
   * ONE ROW, BY ID, AND CONFIRM IS WHY. Both brokered account screens call that route from an
   * effect when they mount, so this read runs on every page load — and it used to be
   * `listServers`, which materialises every tool and every grant in the deployment to answer
   * whether one row is brokered.
   *
   * A ROW THAT IS NOT BROKERED IS REFUSED IN SO MANY WORDS. The id may well name a server this
   * deployment really has — what is wrong is that its connection does not live at Composio, and
   * there is nothing for either route to confirm or to end. `null` from `toolkitOf` also covers an
   * id naming no row at all, which is the same answer from the caller's side.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, as it is on the directory and on connect, and it is
   * {@link BrokerUnconfiguredError}'s own message rather than a sentence written here.
   *
   * The connect route's brokered branch does not come through this function, deliberately: a row
   * that is not brokered has an OAuth flow below it to fall through to, so refusing there would be
   * wrong.
   */
  const brokeredAppFor = async (
    serverId: string,
  ): Promise<
    | { toolkit: string; refusal?: undefined }
    | { toolkit?: undefined; refusal: { error: string; status: 400 | 503 } }
  > => {
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (!toolkit) {
      return {
        refusal: {
          error: "That app is not reached through a broker.",
          status: 400,
        },
      };
    }
    if (!composio) {
      return {
        refusal: { error: new BrokerUnconfiguredError().message, status: 503 },
      };
    }
    return { toolkit };
  };

  /**
   * Ask Composio whether this person's account is really attached, and write the answer down.
   *
   * THE ROUTE EXISTS SO THAT THE VENDOR IS ASKED. The return trip from a consent screen is an
   * ordinary redirect with nothing signed in it, so a browser landing back on the settings page
   * proves nothing: not that the flow finished, and not that it finished with the account a row
   * would go on to claim. Composio tells this deployment nothing by itself — there is no callback
   * of ours in that flow — so unless something asks, all that stands behind the gate every later
   * brokered call passes through is a guess about what a redirect meant.
   *
   * AND IT IS MEANT TO BE CALLED AGAIN, on any page load, which is the other half of why it is
   * here. The row is only a cache of the vendor's last answer, so it drifts by construction — an
   * account ended in Composio's own dashboard, a consent this deployment never saw finish — and
   * calling this heals it in whichever direction it went: written where the vendor says yes,
   * deleted where it says no. Repeating it files no trail rows and moves no timestamps; the store
   * is where that is settled.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED. An administrator adds the app once; confirming one's
   * own connection to it is not an administrative act.
   */
  routes.post(
    "/servers/:id/connection/confirm",
    requireUser,
    async (context) => {
      const resolved = await brokeredAppFor(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }

      /*
       * THE PERSON IS THE SESSION'S, AND THERE IS NO SECOND SOURCE FOR THEM. Nothing here reads a
       * user id out of the body or the query, and that is the property rather than an
       * implementation detail: a confirm writes the row every later brokered call is gated on, so
       * a caller who could name somebody else would be one POST away from recording a connection
       * under a person who never made one — or, the same defect turned around, from deleting the
       * row of a person the vendor answers no for.
       *
       * The store's answer is passed straight back rather than restated here. `connected` is what
       * Composio said, and a shape invented at this layer would be a second opinion about a fact
       * only the vendor holds.
       */
      try {
        return context.json(
          await store.confirmBrokeredConnection({
            toolkit: resolved.toolkit,
            userId: context.var.actor.id,
          }),
        );
      } catch (error) {
        /*
         * A BROKER THAT WOULD NOT ANSWER IS NOT A CONNECTION THAT IS ABSENT.
         *
         * This route is called on every page load, so the tempting answer to a failure is
         * `{ connected: false }` — and that would be this deployment inventing a fact only Composio
         * holds, drawing "Not connected" over a live account and, one step on, deleting the row
         * that says otherwise. The store deletes on a NO from the vendor, and a failure is not a
         * no. So the page is told the ask failed, and what it goes on showing is the last answer
         * Composio gave rather than a guess about this one.
         */
        const refusal = brokerRefusal(
          error,
          "Composio would not say whether this account is connected, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Try again, and ask an administrator to check this deployment's Composio key if it persists.",
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * End this person's own brokered account, at the vendor first and here after.
   *
   * The order is the store's and the argument for it is made there: the row is the only thing that
   * says which app this person connected, so a delete that ran before the revoke could leave a live
   * grant on somebody's mailbox that nothing here can reach. What comes back is what happened —
   * `vendorRevoked` false is a grant that was already gone — and it is passed through rather than
   * rewritten, because telling those two apart is the whole value of the field.
   *
   * `reason` IS "self" BECAUSE OF WHO IS ASKING. The other word the store takes is
   * `person_removed`, which belongs to an administrator offboarding somebody from the People
   * screen. The trail tells the two acts apart by this word and by whether `by` and the owner
   * differ, and on this route they are the same person by construction.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED, for the reason confirm gives: this is somebody
   * ending their own account, not an administrator ending anybody's.
   */
  routes.delete("/servers/:id/connection", requireUser, async (context) => {
    const resolved = await brokeredAppFor(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }

    /*
     * WHOSE ACCOUNT THIS IS COMES FROM THE SESSION, here as on confirm and for a sharper reason: a
     * user id a caller could name would be a DELETE that revokes somebody else's grant at the
     * vendor. It is read once, from `context.var.actor`, and used for both the owner and the actor
     * — nothing in the body or the query is looked at at all.
     */
    try {
      return context.json(
        await store.disconnectBrokered({
          toolkit: resolved.toolkit,
          userId: context.var.actor.id,
          by: context.var.actor.id,
          reason: "self",
        }),
      );
    } catch (error) {
      /*
       * REPEATING IT IS THE RECOVERY, AND THE SENTENCE SAYS SO RATHER THAN GUESSING HOW FAR IT GOT.
       *
       * The revoke runs before anything here is deleted, which is what makes a second press safe:
       * whatever this failed at, the state it leaves is access dead or access untouched, never
       * access live with nothing here able to reach it. Claiming "nothing was changed" would be a
       * guess — a delete that succeeded and an audit write that did not is the same throw — and the
       * one thing a person needs is the button to press, not this deployment's theory of where it
       * stopped.
       */
      const refusal = brokerRefusal(
        error,
        "Composio would not end this account, and gave no reason. Press Disconnect again: the revoke at Composio runs before anything here is deleted, so repeating it is safe and is the whole recovery. Ask an administrator to check this deployment's Composio key if it persists.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends the same way: back at Settings with a word about what happened, and nothing
   * written. There is no useful distinction here for the person between a forged state and an expired
   * one, and spelling out which is which tells anybody probing this endpoint how far they got.
   */
  routes.get("/oauth/callback", async (context) => {
    const failed = connectedAccountsUrlFor(connect?.appUrl, {
      failed: true,
    });
    if (!connect?.publicUrl) return context.redirect(failed);

    const code = context.req.query("code");
    const state = await readConnectState(
      context.req.query("state") ?? "",
      connect.encryptionKey,
    );
    if (!code || !state) return context.redirect(failed);

    /*
     * Is the person in the state still somebody here?
     *
     * Asked here, before the code is redeemed and before anything is written, because a state is
     * good for ten minutes and access can end inside them. Removing somebody deny-lists their
     * address, deletes their sessions and retires the credentials they had already granted — and
     * none of that reaches a consent already in flight at the vendor. Without this, that consent
     * comes back and writes a fresh, live refresh token belonging to somebody who no longer has
     * access, which nothing downstream will ever revoke because nothing knows it was created.
     *
     * The same anonymous failure as an unreadable state. Whether an address is deny-listed is not a
     * fact this endpoint owes an unauthenticated caller.
     */
    if (!(await connect.personHasAccess(state.userId))) {
      return context.redirect(failed);
    }

    const entry = catalogueEntry(state.serverId);
    if (entry?.auth.kind !== "user-oauth") return context.redirect(failed);

    const client = await store.oauthClientFor(state.serverId);
    if (!client) return context.redirect(failed);

    const grant = await redeemAuthorizationCode({
      tokenUrl: entry.auth.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      redirectUri: redirectUriFor(connect.publicUrl),
      verifier: state.verifier,
    });
    if (!grant) return context.redirect(failed);

    /*
     * The last thing that can fail, answered the same way as everything before it.
     *
     * A vault that will not take the grant is this deployment's problem, not the person's, and they
     * have already done their part at the vendor. Unhandled, this threw past the handler and gave
     * them the bare 500 that every other failure on this route was written to avoid, on the one
     * path where they had most reason to think it had worked.
     *
     * Told, because unlike the refusals above this one is nobody's fault but ours, and the person's
     * sentence deliberately says nothing about which failure it was. The refresh token is not
     * logged: it is the one thing here worth stealing, and the row it belonged to was never written.
     */
    try {
      await store.recordConnection({
        serverId: state.serverId,
        userId: state.userId,
        refreshToken: grant.refreshToken,
        scope: grant.scope,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "oauth-connection-not-recorded",
          serverId: state.serverId,
          note: "A person consented and the grant could not be stored. They were sent back to Settings with a failure and will have to connect again.",
          error: String(error),
        }),
      );
      return context.redirect(failed);
    }

    return context.redirect(
      connectedAccountsUrlFor(
        connect.appUrl,
        { serverId: state.serverId },
        // From the sealed state, so the destination is one this deployment chose, not the browser.
        state.returnTo,
      ),
    );
  });

  /**
   * Write a skill.
   *
   * Not admin-only. A skill is an instruction, not a capability: it can only ask a
   * Bot to use tools that Bot was already granted, and every one of those calls is still decided,
   * policy-checked and audited. Adding an MCP server is the opposite, and stays an administrator's.
   *
   * A person's skill is their own. `global` writes one for the whole deployment, which an
   * administrator may do and nobody else.
   */
  routes.post("/skills", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: string;
      title?: string;
      summary?: string;
      instructions?: string;
      global?: boolean;
      tools?: unknown;
    } | null;
    if (!body?.slug || !body?.title?.trim() || !body?.instructions?.trim()) {
      return context.json(
        { error: "A slug, a title and instructions are required." },
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(body.slug)) {
      return context.json(
        { error: "A slug is lower-case letters, numbers and hyphens." },
        400,
      );
    }

    const actor = skillActor(context);
    if (body.global && !actor.isAdmin) {
      return context.json(
        { error: "Only an administrator writes a skill for the deployment." },
        403,
      );
    }

    // Editing an existing slug, which is what a repeated save is, needs the right to edit that
    // skill. Without this, saving over somebody else's name would silently take it.
    const refusal = await skillRefusal(context, body.slug);
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * Absent leaves the declarations alone, so a caller that predates this field does not silently
     * clear one. An array, including an empty one, says what the skill needs now.
     */
    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      return context.json(
        { error: "Tools are a list of serverId/toolName references." },
        400,
      );
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((ref): ref is string => typeof ref === "string")
      : undefined;

    try {
      await store.installSkill({
        slug: body.slug,
        title: body.title.trim(),
        summary: body.summary ?? "",
        instructions: body.instructions.trim(),
        ownerUserId: body.global ? null : actor.id,
        ...(tools === undefined ? {} : { tools }),
        by: actorEmail(context),
      });
    } catch (error) {
      // A ref naming no tool this deployment has seen. Answered rather than thrown, because it is
      // something the person writing the skill can fix and the message says what to fix.
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
    return context.json({ skills: await store.listSkills(actor) });
  });

  routes.delete("/skills/:slug", requireUser, async (context) => {
    const slug = context.req.param("slug");
    const refusal = await skillRefusal(context, slug);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.uninstallSkill(slug, actorEmail(context));
    return context.json({ ok: true });
  });

  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * The kinds of grant this API will act on.
   *
   * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a JSON body, so a type annotation
   * on it is a comment: before this, anything at all could be written into the grant table through
   * the ordinary endpoint, and one kind that was never meant to be settable this way already could.
   */
  const GRANT_KINDS = new Set<PluginKind>(["mcp", "skill", "bot"]);
  const asGrantKind = (value: unknown): PluginKind | null =>
    typeof value === "string" && GRANT_KINDS.has(value as PluginKind)
      ? (value as PluginKind)
      : null;

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    /**
     * Which way this is going, because they are not symmetric.
     *
     * TAKING SOMETHING AWAY IS ALWAYS ALLOWED. The checks below decide whether a grant should exist,
     * and applying them to a revoke turns every one of them into a trap: a `bot` grant made before
     * the grantee moved to its own endpoint — or before this check existed — could never be removed,
     * because the reason it is wrong is the same reason the revoke was refused. An administrator
     * looking at a dead row in the UI would have had no way to delete it.
     */
    intent: "grant" | "revoke",
  ): Promise<string | null> {
    const actor = skillActor(context);

    if (kind === "mcp") {
      return actor.isAdmin
        ? null
        : "An administrator decides which Bots may reach a tool.";
    }

    if (kind === "bot") {
      /*
       * THE ROLE IS CHECKED BEFORE ANYTHING IS LOOKED UP, and that ordering is the point.
       *
       * One Bot reaching another lets it spend that Bot's model calls, wake its computer and reach
       * whatever it may reach, so it is an administrator's decision rather than something somebody
       * attaches to a coworker they own. But this route only requires a signed-in user, so every
       * refusal below is readable by anybody: checking whether the Bot exists, and whether it runs
       * here, before this line handed out three distinguishable answers and turned a 403 into an
       * oracle for other people's private Bots. `handoff.ts` in this same feature collapses exactly
       * this, deliberately, and this had it backwards.
       */
      if (!actor.isAdmin) {
        return "An administrator decides which Bots may hand work to another Bot.";
      }
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, from both ends.
       *
       * The GRANTEE has to run here, because handing work on is a tool this deployment executes: a
       * Bot at an endpoint runs its own loop and is handed descriptions of what it may call back
       * for, and there is no callback path that would execute a hop.
       *
       * The TARGET only has to exist. Being handed work is not the same as being able to hand it on,
       * so a target at its own endpoint is perfectly ordinary — but `ref` is bare text with no
       * foreign key, so a typo stored happily and every hop then refused as not-granted.
       */
      /*
       * A Bot cannot be granted itself. The desk refuses a self-hop outright — "a Bot cannot hand
       * work to itself" — so the row is dead the moment it is written, and reads as configured.
       */
      if (ref === agentId) {
        return "A Bot cannot be granted itself to hand work to.";
      }
      const runsHere = await store.agentRunsHere(agentId);
      if (runsHere === undefined) return "There is no such Bot.";
      if (!runsHere) {
        return `${agentId} runs at its own endpoint, so this deployment cannot offer it a tool for handing work on. Only a Bot that runs here can be given one.`;
      }
      if (!(await store.agentIsRegistered(ref))) {
        return `There is no Bot called ${ref} to hand work to.`;
      }
      return null;
    }

    if (actor.isAdmin) return null;

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to this deployment. An administrator decides which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: string;
      agentId?: string;
    } | null;
    const kind = asGrantKind(body?.kind);
    if (!kind || !body?.ref || !body.agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      body.ref,
      body.agentId,
      "grant",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.grant(kind, body.ref, body.agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    if (!kind || !ref || !agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      ref,
      agentId,
      "revoke",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, ref, agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    // A grant list is a fact about the Bot it belongs to. Left open it says which tools somebody
    // else's private coworker has been given.
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    return context.json(await store.listForAgent(agentId));
  });

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
   *
   * NOTHING IN THIS REPOSITORY CALLS IT. It is what the browser used to post to when a Bot's tool
   * loop ran client-side; that loop moved to the server, and the client helper for this went with it.
   * Kept rather than removed, because #37 hardened it with `canUseBot` after that move — so removing
   * it belongs in a change that says so, not in a merge resolution.
   */
  routes.post("/call", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ref?: string;
      args?: Record<string, unknown>;
      agentId?: string;
    } | null;
    if (!body?.ref || !body.agentId) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
    }

    // Asked before the grant is looked up, and before anything reaches a vendor. The grant says this
    // Bot may use the tool; it says nothing about whether this person may act as this Bot, and the
    // call goes out on the deployment's own credential either way.
    if (!(await canUseBot(context.var.actor, body.agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        /*
         * The user id, not the address.
         *
         * `callTool` keys a per-person connection on `users.id`, so an address here finds nothing and
         * every call through this route would be answered "you have not connected your account" —
         * about a connector the person has connected. It never surfaced because a Bot's own tool loop
         * runs on the server and does not come through here.
         *
         * The other uses of `actorEmail` in this file are `by:` on configuration changes, where an
         * address is the useful thing to record. This one is an identity being resolved, not a name
         * being written down, and the two are not interchangeable.
         */
        actorId: context.var.actor.id,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * Ours, and so neither the vendor's fault nor this caller's business.
       *
       * CRITERION. A fault on the `isDeploymentFault` shelf is not reported through the branch
       * below, and its sentence does not leave this process by this route.
       *
       * REASON. Two things would be wrong at once. `failed: true` and 502 say somebody else's
       * software did not answer, which is a false statement about a call that never went out —
       * and this route is `requireUser`, not `requireAdmin`, so the sentence naming our columns
       * and the correction to make would be readable by anybody with a session. The operator who
       * can act on it reads it on the refresh route above, which is admin-gated; here the honest
       * answer is that the deployment cannot make this call as it stands.
       */
      if (isDeploymentFault(error)) {
        return context.json(
          {
            error:
              "That tool is not configured in a way this deployment can act on. An administrator has to look at the server it belongs to.",
          },
          500,
        );
      }
      // A server that failed is not a refusal, and saying so matters: one means the deployment
      // decided against it, the other means somebody else's software did not answer.
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The server did not answer.",
          failed: true,
        },
        502,
      );
    }
  });

  return routes;
}
