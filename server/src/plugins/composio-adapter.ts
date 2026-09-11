import { Composio } from "@composio/core";
import type { BrokerApp, ComposioBroker } from "./broker";
import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  LISTING_LIMIT,
} from "./composio";

/**
 * The one file in `server/src` that imports `@composio/core`, and what it owes the rest of them.
 *
 * `./composio` describes calling an action and `./broker` describes everything that has to be true
 * before one can be called; both are written as narrow projections that name no vendor type, so
 * that the SDK's shape — its constructor, its retries, its zod schemas and whatever the next
 * version renames — is confined here. This module is the adapter that satisfies both from one
 * client. A second importer of `@composio/core` under `server/src` would undo that, because the
 * point of a single import site is that a version bump has exactly one file to be read against.
 *
 * NO SESSION IS EVER CREATED, AND THAT IS A SECURITY BOUNDARY RATHER THAN A PREFERENCE. The SDK's
 * `composio.create(...)` and `sessions.create(...)` open a Composio tool-router session, and a
 * session brings Composio's own hosted surface with it — a remote shell and a Python sandbox that
 * this deployment neither asked for, cannot see into, and could not audit if a model reached them.
 * Everything below is a plain per-call request carrying a user id. A `create` of a session
 * anywhere in this file is a defect, not an optimisation, and it will not look like one: the
 * session API is the shortest path to most of what this file does the long way.
 *
 * EVERY LISTING PASSES AN EXPLICIT LIMIT. Composio's default page is 20, which is smaller than the
 * number of actions Gmail alone publishes, and for a tool listing the default does a second thing
 * as well: `getRawComposioTools` sets `important=true` whenever a toolkit query arrived with no
 * limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so an
 * omitted limit silently narrows the answer to the vendor's own "important" subset and nothing in
 * the result says a filter was applied. A limit is therefore not tuning; it is the difference
 * between the list and a fragment of it that reads exactly like the list. {@link LISTING_LIMIT} is
 * the documented ceiling, and `./composio` explains why one page at the ceiling is the largest
 * listing this SDK can express at all.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It arrives as {@link createComposioClient}'s only argument,
 * goes straight into the vendor's constructor, and is held from there on by the vendor's client
 * inside a closure. Nothing below logs it, no thrown message quotes it, and neither of the two
 * returned objects carries a field that could be read back to it — they expose eight methods and
 * no state. A key in a log line is a key in a log aggregator, and a key in an error message is a
 * key in an audit row and in a model's context.
 */

/**
 * One tool as the vendor hands it over, in as much detail as anything here reads.
 *
 * Declared structurally rather than imported as `Tool`, for the same reason the seams it feeds are
 * structural: a field this file does not read is a field a vendor rename cannot break. `toolkit`
 * is optional because the SDK spells it optional — see {@link ComposioActions.execute} below for
 * what is done when it is in fact missing.
 */
type VendorTool = {
  slug: string;
  description?: string;
  inputParameters?: Record<string, unknown>;
  tags?: string[];
  version?: string;
  toolkit?: { slug: string };
};

/**
 * One catalogue row as the vendor hands it over.
 *
 * `meta` is where all of it lives and every field of it is optional, which is not the SDK being
 * cautious: Composio genuinely publishes toolkits with no logo, no description and no category.
 * See {@link ComposioBroker.listApps} below for what each absence becomes.
 */
type VendorToolkit = {
  slug: string;
  name: string;
  meta: {
    description?: string;
    logo?: string;
    categories?: { slug: string; name: string }[];
    toolsCount?: number;
  };
};

/**
 * What this adapter needs of `@composio/core`'s client, written as a shape rather than as a class.
 *
 * A TEST SATISFIES IT WITH AN OBJECT LITERAL, which is the entire argument for it and the reason
 * {@link buildComposioClient} takes one of these instead of an API key. The vendor's own client
 * cannot be constructed without a key and answers nothing without a network, so an adapter that
 * built its own client would be an adapter no test could reach — and this is the file where the
 * field names, the argument order and the refusal below would go wrong unnoticed.
 *
 * Every member is written with METHOD syntax deliberately. Method parameters are compared
 * bivariantly, so a real `Composio` — whose signatures carry optional request-options arguments
 * and wider parameter types than the calls here use — satisfies this without a cast.
 */
export type ComposioVendor = {
  tools: {
    getRawComposioTools(query: {
      toolkits: string[];
      limit: number;
    }): Promise<VendorTool[]>;
    getRawComposioToolBySlug(
      slug: string,
      options?: { version?: string },
    ): Promise<VendorTool>;
    execute(
      slug: string,
      body: {
        arguments: Record<string, unknown>;
        userId: string;
        version: string;
      },
    ): Promise<ComposioResult>;
  };
  toolkits: {
    get(query: { limit: number; sortBy: "usage" }): Promise<VendorToolkit[]>;
    authorize(
      userId: string,
      toolkit: string,
    ): Promise<{ redirectUrl?: string | null }>;
  };
  authConfigs: {
    list(query: {
      toolkit: string;
      limit: number;
    }): Promise<{ items: { id: string; name: string }[] }>;
    create(
      toolkit: string,
      options: { type: "use_composio_managed_auth"; name: string },
    ): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      /**
       * The one status this file ever asks for, spelled as the literal the SDK's enum admits.
       *
       * Written as `"ACTIVE"[]` rather than `string[]` because the vendor's parameter is an enum
       * and a widened array does not satisfy it. The narrowness is worth keeping for its own sake
       * too: a status this deployment has not thought about cannot be asked for by accident.
       */
      statuses: "ACTIVE"[];
      limit: number;
    }): Promise<{ items: { id: string }[] }>;
    delete(id: string): Promise<unknown>;
  };
};

/**
 * The suffix every auth config this deployment creates carries, so a reader can tell whose it is.
 *
 * An auth config is visible in Composio's own dashboard beside any that were made by hand there,
 * and the two are otherwise indistinguishable. The name is the only field this deployment gets to
 * choose, so it is where the provenance goes.
 */
const CONFIG_SUFFIX = "(OpenBot)";

/**
 * Both seams, over one vendor client.
 *
 * TAKING THE VENDOR OBJECT RATHER THAN A KEY IS THE SEAM. It is what lets every test of this
 * file's own decisions — which limit went out, which field became which, which call was refused
 * before it was made — run against an object literal and never a socket. {@link createComposioClient}
 * is the one line that turns a key into a vendor, and it is deliberately too thin to have a bug in.
 *
 * The vendor is captured in a closure rather than stored on either returned object, so neither
 * `actions` nor `broker` offers a route back to the client or to the key it holds.
 */
export function buildComposioClient(vendor: ComposioVendor): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  /**
   * This person's live accounts for this app, which two of the broker's questions are about.
   *
   * Shared because {@link ComposioBroker.isConnected} and {@link ComposioBroker.revoke} have to
   * agree: "connected" and "there is something to revoke" are the same fact, and two listings
   * written separately drift apart the first time one of them gains a status the other lacks.
   *
   * ACTIVE ONLY. An `INITIATED` account is somebody who started an authorization and never
   * finished it, and an `EXPIRED` or `REVOKED` one is a grant that no longer opens anything;
   * counting either as connected tells a person their app is wired up and then fails every call
   * they make with it.
   */
  const activeAccounts = async (userId: string, toolkit: string) => {
    const answer = await vendor.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: [toolkit],
      statuses: ["ACTIVE"],
      limit: LISTING_LIMIT,
    });
    return answer.items;
  };

  /**
   * This deployment's auth configs for one app.
   *
   * EVERYTHING THIS LISTING RETURNS BELONGS TO THIS DEPLOYMENT, which is what makes the two
   * callers below legitimate. An auth config is scoped to the project the API key belongs to, so
   * the key is the filter: there is no other tenant's config to be found here and none of ours is
   * hidden from it.
   */
  const authConfigsFor = async (toolkit: string) => {
    const answer = await vendor.authConfigs.list({
      toolkit,
      limit: LISTING_LIMIT,
    });
    return answer.items;
  };

  const actions: ComposioActions = {
    async listActions(toolkit, page): Promise<ComposioAction[]> {
      /*
       * The caller's page is passed through rather than defaulted here, because the seam made
       * `page` required precisely so that no layer could quietly supply one. See the module
       * comment on what an omitted limit does beyond truncating.
       */
      const tools = await vendor.tools.getRawComposioTools({
        toolkits: [toolkit],
        limit: page.limit,
      });
      /*
       * Mapped field by field rather than spread, so what crosses the seam is the four things
       * `./composio` documents and not whatever else the vendor's tool object happens to carry.
       * `inputParameters` in particular goes straight in front of a model.
       */
      return tools.map((tool) => ({
        slug: tool.slug,
        description: tool.description,
        inputParameters: tool.inputParameters,
        tags: tool.tags,
        version: tool.version,
      }));
    },

    async execute(call, args): Promise<ComposioResult> {
      /*
       * THE TOOL IS RESOLVED BEFORE IT IS RUN, AND THAT COSTS A ROUND TRIP ON PURPOSE.
       *
       * Composio's execute takes the slug alone — its REST parameters have no toolkit field — so
       * the pair the caller was gated on cannot travel on the wire, and the obligation
       * {@link ComposioActions.execute} writes down has to be discharged here instead. The
       * resolved tool carries the app the vendor will actually run it against, so asking for it
       * first is what makes the check possible at all.
       *
       * `tools.execute` resolves the same tool again internally, so this is a second request
       * rather than a saved one. It buys the one thing a single request cannot: a mismatch that is
       * refused before anything runs, rather than discovered in an audit row afterwards.
       */
      const resolved = await vendor.tools.getRawComposioToolBySlug(call.slug, {
        version: call.version,
      });
      const ran = resolved.toolkit?.slug;
      if (ran !== call.toolkit) {
        /*
         * REFUSED RATHER THAN FORWARDED, and both apps are named.
         *
         * The gate in `./access` cleared this run against the app the connection's url names
         * NOW; the slug was recorded by a listing made at some earlier time. Where the two
         * disagree — a url edited between a refresh and a call — forwarding runs one person's
         * Gmail action under a gate that only ever examined their Slack connection. A reader
         * holding only one of the two names cannot tell which of the two is the wrong one, so
         * both go in the sentence. An app the vendor did not name at all is the same refusal:
         * this deployment cannot show that the call is about the app it was gated on.
         */
        throw new Error(
          `${call.slug} was not sent to Composio: this connection is for ${call.toolkit}, and Composio resolves that action to ${
            ran ?? "no app at all"
          }. Refreshing this app's tools on its Plugins page recovers it where the action was recorded against a url that has since changed.`,
        );
      }

      return vendor.tools.execute(call.slug, {
        arguments: args,
        userId: call.userId,
        version: call.version,
      });
    },
  };

  const broker: ComposioBroker = {
    async listApps(): Promise<BrokerApp[]> {
      /*
       * ONE PAGE AT THE CEILING, SORTED BY USAGE, AND NO SEARCH TERM.
       *
       * The order matters because the page is finite: at the ceiling the apps most likely to be
       * wanted are the ones that must not be the ones cut off. The absent search term is the
       * subtler half — the SDK's list params name no search field
       * (`ToolkitsListParamsSchema`, `@composio/core` 0.18.1, `src/types/toolkit.types.ts:9-15`)
       * and the parse strips what it does not name, so a term passed here would vanish before the
       * request and leave a caller believing they had filtered a list nobody filtered. Searching
       * the catalogue is this deployment's own job, over the rows below.
       */
      const toolkits = await vendor.toolkits.get({
        limit: LISTING_LIMIT,
        sortBy: "usage",
      });
      return toolkits.map((toolkit) => ({
        slug: toolkit.slug,
        name: toolkit.name,
        /*
         * Each absence becomes the value that reads honestly on an administrator's screen. An
         * empty description shows as no description; a null logo is the field's documented way of
         * saying the vendor published none, which renders as a gap rather than as a broken image.
         *
         * The categories are the DISPLAY names rather than the slugs, because this list is read
         * by a person choosing an app and "Productivity" is what they are choosing by.
         *
         * A MISSING COUNT BECOMES ZERO, WHICH IS THE ONE IMPERFECT ANSWER HERE. `actionCount` is a
         * number and the shape offers no way to say "not published", so a toolkit that publishes
         * no count reads as an app with no actions. It is the conservative direction — it
         * understates the size of a change rather than overstating it — and Composio publishes a
         * count for every toolkit measured, so this is a guard against the vendor rather than a
         * routine case.
         */
        description: toolkit.meta.description ?? "",
        logo: toolkit.meta.logo ?? null,
        categories: (toolkit.meta.categories ?? []).map(
          (category) => category.name,
        ),
        actionCount: toolkit.meta.toolsCount ?? 0,
      }));
    },

    async ensureAuthConfig({ toolkit, name }): Promise<void> {
      /*
       * IDEMPOTENT BY LOOKING FIRST, because a second config is not a duplicate — it is a split.
       * A person's existing connection is created against one particular auth config, so creating
       * another and connecting the next person to that leaves two populations of connections for
       * one app, and removing "the" config later drops half of them.
       *
       * This is a read followed by a write and therefore not atomic: two administrators pressing
       * enable at the same instant can both find nothing and both create. Composio offers no
       * create-if-absent, so the window is the vendor's rather than this deployment's, and the
       * cost of losing that race is a spare config rather than a lost connection.
       */
      const existing = await authConfigsFor(toolkit);
      if (existing.length > 0) return;

      await vendor.authConfigs.create(toolkit, {
        type: "use_composio_managed_auth",
        name: `${name} ${CONFIG_SUFFIX}`,
      });
    },

    async deleteAuthConfig(toolkit): Promise<void> {
      /*
       * QUIET WHERE THERE IS NOTHING TO DELETE, because removing an app has to be able to happen
       * twice. An app can be removed, re-enabled and removed again, two administrators can press
       * the button together, and an app enabled before this deployment created configs at all has
       * none to drop. In every one of those the end state is the one that was asked for, so a
       * throw would report a failure while the caller got exactly what they wanted.
       *
       * ONE CONFIG, NOT ALL OF THEM. {@link ComposioBroker.ensureAuthConfig} creates at most one,
       * so a second config for the same app was made by hand in Composio's dashboard for some
       * purpose this deployment knows nothing about, and removing an app here is not a mandate to
       * delete somebody's dashboard work.
       */
      const [config] = await authConfigsFor(toolkit);
      if (!config) return;
      await vendor.authConfigs.delete(config.id);
    },

    async authorize({ userId, toolkit }): Promise<{ redirectUrl: string }> {
      const request = await vendor.toolkits.authorize(userId, toolkit);
      const redirectUrl = request.redirectUrl;
      if (!redirectUrl) {
        /*
         * The SDK spells `redirectUrl` nullable because not every auth scheme has one — an API-key
         * toolkit is connected by typing a secret, not by visiting a page. This deployment's
         * enablement flow sends a person to a url, so no url is nothing to do rather than a
         * success, and the sentence says which app it was about. The url itself is never quoted
         * anywhere, here or elsewhere: whoever opens it attaches an account to this person's
         * connection, so it is handed to the browser that asked and then forgotten.
         */
        throw new Error(
          `Composio began a connection to ${toolkit} but answered with no page to visit, so there is nothing to send this person to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.`,
        );
      }
      return { redirectUrl };
    },

    async isConnected({ userId, toolkit }): Promise<boolean> {
      return (await activeAccounts(userId, toolkit)).length > 0;
    },

    async revoke({ userId, toolkit }): Promise<boolean> {
      /*
       * THE ANSWER IS WHAT HAPPENED, not whether the call threw. `false` here means there was no
       * grant to withdraw, which is what the audit trail's `vendorRevoked` is for: a reader has to
       * be able to tell a grant this deployment ended from one that outlives it somewhere else.
       *
       * EVERY ACCOUNT, not the first. One person can hold more than one account for one app — two
       * mailboxes, or a stale account beside a fresh one — and each of them is a grant this
       * deployment's calls could run under. Leaving one behind would report a revocation that did
       * not revoke.
       */
      const accounts = await activeAccounts(userId, toolkit);
      for (const account of accounts) {
        await vendor.connectedAccounts.delete(account.id);
      }
      return accounts.length > 0;
    },
  };

  return { actions, broker };
}

/**
 * The one line that turns this deployment's API key into a vendor client.
 *
 * Everything this file decides lives in {@link buildComposioClient}, which is why this function has
 * no body worth testing: it constructs the vendor and hands it over. The key is a parameter here
 * and a private field of the vendor's client thereafter, and no path out of this module carries it
 * — see the module comment.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  return buildComposioClient(new Composio({ apiKey }));
}
