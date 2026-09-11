import { Composio } from "@composio/core";
import {
  type BrokerApp,
  type ComposioBroker,
  BrokerRefusalError,
} from "./broker";
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
 * One auth config as the vendor hands it over, which is three fields because all three decide.
 *
 * `name` IS THE ONLY PROVENANCE THERE IS. Composio publishes no field saying which client created a
 * config, and the listing is scoped to the project rather than to this deployment, so a config an
 * operator made by hand in the dashboard comes back beside the ones made here and is otherwise
 * identical. The name is the one field this deployment chooses, which is why {@link CONFIG_SUFFIX}
 * is written into it and why every decision below reads it.
 *
 * `status` because a DISABLED config is still a config: it answers the listing, it satisfies the
 * "does one exist" question, and a connect link minted against it does not work. The two facts have
 * to be separable or an app with a disabled config reads as an app that is ready.
 */
type VendorAuthConfig = {
  id: string;
  name: string;
  status: "ENABLED" | "DISABLED";
};

/**
 * The connected-account statuses this file knows how to ask for, as the literals the SDK admits.
 *
 * The whole enum is named rather than the two or three in use, because the point of the two lists
 * below is that they are CHOICES: a reader comparing them can see which statuses each question
 * leaves out, and a status added by a vendor version shows up here as a name nothing mentions
 * rather than as an answer that quietly got narrower. Written as literals for the reason the
 * previous `"ACTIVE"[]` was: the vendor's parameter is an enum and a widened `string[]` does not
 * satisfy it.
 */
type VendorAccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

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
 *
 * THE TWO DELETES ARE NOT `Composio`'s, AND THAT IS THE ONE PLACE THIS SHAPE DIVERGES FROM IT. Both
 * of the vendor's own wrappers hard-code the request body they send — `this.client.authConfigs
 * .delete(nanoid, undefined, requestOptions)` and the same line for connected accounts
 * (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311` and
 * `src/models/ConnectedAccounts.ts:532-540`) — so through them the `revoke_on_delete` parameter
 * cannot be passed at all, and both calls soft-delete while the grant at Google or Slack stands. So
 * the shape below asks for the underlying client's signature instead, and
 * {@link createComposioClient} satisfies it from `composio.getClient()`. See
 * {@link ComposioBroker.revoke} for what that flag is and what its absence made this deployment
 * claim.
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
  };
  authConfigs: {
    list(query: {
      toolkit: string;
      limit: number;
      /**
       * Ask for the disabled ones too, ALWAYS, which is why this is the literal and not a boolean.
       *
       * The vendor's listing returns enabled configs unless asked otherwise
       * (`AuthConfigListParamsSchema.showDisabled`, `@composio/core` 0.18.1,
       * `src/types/authConfigs.types.ts:124-131`), and a config this listing cannot see is a config
       * {@link ComposioBroker.ensureAuthConfig} creates a second of — which is the exact split that
       * method exists to prevent, arriving through the one door it was not watching. Every question
       * this file asks of the listing is better served by seeing a disabled config and saying so:
       * creation must not duplicate it, deletion must remove it, and consent must refuse against
       * it rather than mint a link that cannot work.
       */
      showDisabled: true;
    }): Promise<{ items: VendorAuthConfig[] }>;
    create(
      toolkit: string,
      options: { type: "use_composio_managed_auth"; name: string },
    ): Promise<unknown>;
    /**
     * Delete one auth config, and ask for the upstream credentials on it to be revoked too.
     *
     * THE SAME TRAP AS THE ACCOUNT DELETE BELOW, one level up. The endpoint "soft-deletes an
     * authentication configuration" and revokes "the upstream credentials of every connection using
     * this auth config" only when the flag is passed (`@composio/client` 0.1.0-alpha.76,
     * `resources/auth-configs.d.ts:60-72` and `:651-659`), so a delete without it leaves every
     * grant that was ever made against this config alive at the provider.
     *
     * WHICH IS WHY IT IS PASSED HERE EVEN THOUGH THE ACCOUNTS WERE ALREADY ASKED FOR INDIVIDUALLY.
     * Removing an app revokes each connected person first and drops the config last, and that loop
     * reaches exactly the people this deployment has a `composio_connections` row for. An account
     * whose row drifted — cleared by a confirm that Composio answered `false` to, or lost with a
     * database this deployment restored — is invisible to it and still live at the vendor. This is
     * the one call that reaches those, and there is nothing on this config that removing the app is
     * not meant to end.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      /**
       * Which statuses this particular question is about — see {@link CONNECTED} and
       * {@link REVOCABLE}, which are the only two answers this file gives.
       */
      statuses: VendorAccountStatus[];
      /**
       * Both sharing models, ALWAYS, which is why this is the literal and not the enum.
       *
       * OMITTING IT IS NOT "NO OPINION", in exactly the way an omitted limit is not. The parameter
       * defaults to private accounts only (`ConnectedAccountListParamsSchema.accountType`,
       * `@composio/core` 0.18.1, `src/types/connectedAccounts.types.ts:286-293`), so a person whose
       * account for an app is a SHARED one reads as not connected, is told to connect an app they
       * already have, and — far worse — is invisible to the revoke, which then reports that there
       * was nothing to withdraw while their grant stands. Neither of the two questions this file
       * asks has any reason to care how an account is shared: the gate is about whether this person
       * can act through the app, and the revoke is about ending every account they can act through.
       */
      accountType: "ALL";
      limit: number;
    }): Promise<{ items: { id: string }[] }>;
    /**
     * Mint one person's connect link against one auth config, with the page to come back to.
     *
     * `link` RATHER THAN `initiate`, AND RATHER THAN `toolkits.authorize`. All three end at a
     * redirect url, and only the choice between them decides whether this deployment keeps working.
     * `toolkits.authorize` takes a user id, a toolkit and an optional auth config id and has no
     * parameter for a callback at all (`@composio/core` 0.18.1, `src/models/Toolkits.ts:333-338`),
     * which is why consent used to end on Composio's hosted page — the address below has nowhere
     * to travel on that call. `initiate` does carry one (`:249`), but the endpoint under it is
     * retired for Composio-managed OAuth on redirectable schemes — cutover 2026-05-08 for new
     * organizations and 2026-07-03 for the rest, after which it throws
     * `ComposioLegacyConnectedAccountsEndpointRetiredError` (`src/models/ConnectedAccounts.ts:146-160`)
     * — and `use_composio_managed_auth` is exactly what {@link ComposioBroker.ensureAuthConfig}
     * creates. `link` is the vendor's own named replacement for that combination, carries the
     * callback, and answers in the same shape.
     *
     * TAKING THE AUTH CONFIG ID IS NOT A COST HERE. It is the one thing `toolkits.authorize` was
     * doing for us, and it did it by listing the configs and creating one at Composio's managed
     * defaults where it found none — which this deployment already does for itself, at enable
     * time, named so an operator can find it in their dashboard. The listing below is that same
     * read; the creation is not repeated, because an app with no config is a state to report
     * rather than one to paper over.
     */
    link(
      userId: string,
      authConfigId: string,
      options: { callbackUrl: string },
    ): Promise<{ redirectUrl?: string | null }>;
    /**
     * Delete one connected account, and ask for the grant behind it to be revoked too.
     *
     * WITHOUT THE FLAG THIS CALL DOES NOT REVOKE ANYTHING, and that is the vendor's own description
     * of it: it "soft-deletes a connected account by marking it as deleted in the database", which
     * "prevents the account from being used for API calls but preserves the record"
     * (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:59-72`). The refresh
     * token at Google or Slack survives that untouched. Every path in this deployment that claims
     * to end somebody's access — a person disconnecting, an administrator removing an app, a person
     * being offboarded — runs through here, so an unflagged delete made all three of those claims
     * false at once and wrote `true` into the audit trail beside them.
     *
     * WHAT THE FLAG BUYS IS A REQUEST AND NOT A RESULT, which is the whole reason
     * {@link ComposioBroker.revoke}'s answer is named the way it is. The upstream revocation runs as
     * a background job; the response carries its `revoke_job_id` and the vendor documents that no
     * generally available endpoint polls it (`:7447-7459`). So the answer is deliberately typed as
     * `unknown` and read for nothing: there is no field on it this deployment could turn into a
     * stronger claim than "we asked", and a shape declared here that nothing reads is a shape a
     * vendor rename can break for no benefit.
     */
    delete(id: string, params: { revoke_on_delete: true }): Promise<unknown>;
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
 * Whether this deployment made that auth config, which is the question every decision here turns on.
 *
 * THE SUFFIX IS WRITTEN FOR EXACTLY THIS AND WAS NOT BEING READ. Both callers used to take the
 * first row of an unordered listing, and the two consequences are of different sizes. Removing an
 * app deleted whatever came back first — which can be a config an operator built by hand, with
 * their own scopes and their own tool restrictions, taking every account on it down with it.
 * Beginning a connection attached a person to whatever came back first — which can be a
 * configuration nobody here chose and this deployment cannot see or tighten. And because the order
 * is the vendor's, the two calls can resolve DIFFERENT rows, so an app could be removed while
 * people kept connecting against a config the removal left behind.
 *
 * MATCHED ON THE END OF THE NAME rather than on the whole of it, because the rest of the name is an
 * app's title as an administrator saw it at enable time and titles are edited. The suffix is the
 * part this file writes. Trailing whitespace is tolerated for the same reason it is tolerated
 * anywhere a human-edited string is compared: a name that picked up a space in a dashboard is the
 * same config.
 */
function madeHere(config: VendorAuthConfig): boolean {
  return config.name.trimEnd().endsWith(CONFIG_SUFFIX);
}

/**
 * The statuses that answer "is this person connected", which is the narrow question of the two.
 *
 * ACTIVE ONLY. An `INITIATED` account is somebody who started an authorization and never finished
 * it, and an `EXPIRED` or `REVOKED` one is a grant that no longer opens anything; counting any of
 * them as connected tells a person their app is wired up and then fails every call they make with
 * it.
 */
const CONNECTED: VendorAccountStatus[] = ["ACTIVE"];

/**
 * The statuses that answer "what is there to revoke", which is a deliberately wider question.
 *
 * THE TWO QUESTIONS ARE NOT THE SAME ONE, AND TREATING THEM AS ONE LEFT GRANTS STANDING. This used
 * to be a single ACTIVE listing shared by both, on the argument that "connected" and "there is
 * something to revoke" are the same fact. They are not. A half-finished consent can already have
 * been granted at the provider with the callback never delivered; an `EXPIRED` account is an access
 * token that lapsed and a refresh token that did not; an `INACTIVE` one is a live grant the vendor
 * has set aside. None of them should tell a person they are connected, and every one of them is
 * something whose withdrawal is the entire point of pressing disconnect.
 *
 * `REVOKED` IS THE ONE STATUS LEFT OUT, and left out on purpose rather than forgotten. It is the
 * only value that positively says the grant is already gone, so including it would have this
 * deployment delete a tombstone and then record that it ended somebody's access — the one way the
 * audit field can be made to lie in the direction nobody would check.
 */
const REVOCABLE: VendorAccountStatus[] = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
];

/**
 * How long one catalogue answer is served to everybody who asks for it.
 *
 * THE CATALOGUE IS READ ONCE PER SEARCH KEYSTROKE OTHERWISE, WHICH IS WHAT THIS IS ABOUT. The admin
 * picker debounces its search field and then asks `/composio/apps`, and that route filters in this
 * process precisely because Composio's toolkit listing takes no search term — so every distinct term
 * a person types is another request for the whole directory, a few hundred rows of it, to answer a
 * question about one. Typing "linear" pulls the catalogue four or five times, and enabling the app
 * afterwards pulls it once more.
 *
 * TEN MINUTES BECAUSE OF WHAT GOES STALE IN IT. The rows are Composio's published toolkits: an app
 * is added to their catalogue or its action count moves every so often, never within one
 * administrator's sitting, and the worst a stale row can do here is show a description or a count
 * that is a few minutes behind. Held for a working session it would be a cache nobody could explain
 * to an operator whose new app is missing; held for seconds it would not survive the debounce it
 * exists for.
 */
const DIRECTORY_TTL_MS = 10 * 60 * 1000;

/**
 * The held catalogue as a copy nobody else holds, which is what makes handing it out safe.
 *
 * WHAT WAS HANDED OUT WAS THE CACHE ITSELF. One array of one set of row objects was returned to
 * every caller for ten minutes, so a route that sorted the rows in place reordered the catalogue for
 * everybody, and one that edited a row — a title trimmed for display, a description truncated —
 * edited what the next caller would read as Composio's answer. Nothing does that today, which is
 * precisely the problem with leaving it: the first caller that does will have changed a cache it
 * had no idea it was holding, and the fault will surface in the NEXT request rather than its own.
 *
 * `categories` IS COPIED TOO, because a shallow spread of the row would hand the same array on. It
 * is the one field here that is not a primitive.
 *
 * COPIED RATHER THAN FROZEN, which was the other candidate. Freezing would make the sharing safe by
 * making a mutation throw, but the type says `BrokerApp[]` and a caller is entitled to sort a list
 * it was given; turning a reasonable caller into a `TypeError` is a worse answer than a few hundred
 * small objects, which is nothing beside the request this cache exists to avoid.
 */
function copyOf(apps: Promise<BrokerApp[]>): Promise<BrokerApp[]> {
  return apps.then((held) =>
    held.map((app) => ({ ...app, categories: [...app.categories] })),
  );
}

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
 *
 * @param now The clock the catalogue's lifetime is measured against, injected for the same reason
 * the vendor is. A test that could not move the clock could only assert the cache's hit by counting
 * calls and would have to sleep ten minutes to assert its expiry, so the window would be the one
 * thing here no test could reach. It is a parameter of the builder rather than of
 * {@link ComposioBroker.listApps}, because the seam's callers are routes and none of them has an
 * opinion about what time it is.
 */
export function buildComposioClient(
  vendor: ComposioVendor,
  now: () => number = Date.now,
): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  /**
   * This person's accounts for this app, in whichever states the ASKING question is about.
   *
   * ONE LISTING WITH THE STATUSES AS ITS ARGUMENT, rather than one listing both callers share.
   * They shared one until it turned out that the shared answer was wrong for one of them: see
   * {@link CONNECTED} and {@link REVOCABLE} for why "is this person connected" and "what is there
   * to revoke" are different questions. What they do share is everything a drift between them
   * would come from — the breadth of `accountType`, the limit, and the fact that both ask about one
   * person and one app — so the difference between them is exactly the list of statuses and is
   * visible at both call sites.
   */
  const accountsFor = async (
    userId: string,
    toolkit: string,
    statuses: VendorAccountStatus[],
  ) => {
    const answer = await vendor.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: [toolkit],
      statuses,
      accountType: "ALL",
      limit: LISTING_LIMIT,
    });
    return answer.items;
  };

  /**
   * The auth configs for one app that THIS DEPLOYMENT made, oldest name first.
   *
   * THE LISTING IS SCOPED TO THE PROJECT AND NOT TO THIS DEPLOYMENT, which is the correction. An
   * auth config is scoped to the project the API key belongs to — so nothing here is hidden from
   * this listing, and that was read as "everything it returns is ours". It is not: an operator with
   * the same project open in Composio's dashboard can create configs for the same app by hand, for
   * purposes this deployment knows nothing about. {@link madeHere} is the only thing that tells the
   * two apart, and every caller below is about an object one of them must not touch.
   *
   * SORTED SO THAT TWO CALLERS AGREE. The vendor's order is not documented, and the whole failure
   * being fixed here is two calls resolving different rows; a total order on the id makes the
   * choice this file makes a stable one, whoever asks and whenever.
   */
  const configsMadeHere = async (toolkit: string) => {
    const answer = await vendor.authConfigs.list({
      toolkit,
      limit: LISTING_LIMIT,
      showDisabled: true,
    });
    return answer.items
      .filter(madeHere)
      .sort((one, other) => one.id.localeCompare(other.id));
  };

  /**
   * Ask for every one of them and answer with what refused, rather than stopping at the first.
   *
   * A THROW MID-LOOP ABANDONS GRANTS THAT ARE STILL LIVE. Both callers below are deleting a set of
   * things that each independently hold somebody's access, and an exception out of the second of
   * five leaves three untouched and unmentioned — while the caller is told only about the one that
   * failed, so nothing in the answer says the loop did not finish. Attempting all of them makes the
   * failure a statement about a set: this many were asked for and this many refused.
   *
   * SERIALLY RATHER THAN TOGETHER, for the same reason every other call here goes out one at a
   * time: the vendor rate-limits, and a person with several accounts is not a reason to open
   * several connections. The order is the listing's, which is sorted.
   */
  const askForEach = async <T>(
    items: T[],
    ask: (item: T) => Promise<unknown>,
  ): Promise<unknown[]> => {
    const refused: unknown[] = [];
    for (const item of items) {
      try {
        await ask(item);
      } catch (error) {
        refused.push(error);
      }
    }
    return refused;
  };

  /**
   * The catalogue answer this process is currently serving, and the moment it was asked for.
   *
   * A PROMISE RATHER THAN THE ROWS, WHICH IS THE WHOLE ANSWER TO CONCURRENCY. The entry is written
   * before the request is answered, so a second caller arriving while the first is still in flight
   * finds it and awaits the same request. Holding the resolved rows instead would leave the window
   * this cache exists to close wide open: three people opening the picker together, or one person's
   * debounce firing twice, are exactly the case where nothing is cached yet, and each of them would
   * start their own catalogue fetch and then overwrite each other's answer.
   *
   * IT IS PER BUILT CLIENT, not per module. This adapter is built once per deployment key, so in
   * this process that is one cache; in a test it is one cache per {@link buildComposioClient}, which
   * is what lets each test below start from nothing without an API for emptying it.
   */
  let heldDirectory: { at: number; apps: Promise<BrokerApp[]> } | null = null;

  /**
   * The catalogue as the vendor answers it, mapped to the rows an administrator chooses from.
   *
   * ONE PAGE AT THE CEILING, SORTED BY USAGE, AND NO SEARCH TERM.
   *
   * The order matters because the page is finite: at the ceiling the apps most likely to be wanted
   * are the ones that must not be the ones cut off. The absent search term is the subtler half —
   * the SDK's list params name no search field
   * (`ToolkitsListParamsSchema`, `@composio/core` 0.18.1, `src/types/toolkit.types.ts:9-15`)
   * and the parse strips what it does not name, so a term passed here would vanish before the
   * request and leave a caller believing they had filtered a list nobody filtered. Searching the
   * catalogue is this deployment's own job, over the rows below.
   */
  const fetchDirectory = async (): Promise<BrokerApp[]> => {
    const toolkits = await vendor.toolkits.get({
      limit: LISTING_LIMIT,
      sortBy: "usage",
    });

    if (toolkits.length >= LISTING_LIMIT) {
      /*
       * A FULL PAGE IS NOT A COMPLETE CATALOGUE, and this deployment cannot find out which it is.
       * The same refusal `./composio` makes of a full action listing, for the same reason and one
       * line of vendor code apart.
       *
       * `LISTING_LIMIT` is the largest page the toolkit endpoint allows, and while its params do
       * name a `cursor` (`ToolkitsListParamsSchema`, `@composio/core` 0.18.1,
       * `src/types/toolkit.types.ts:9-15`) there is nothing to put in it: the SDK's
       * `ToolKitListResponse` is a bare array (`:53`) and `transformToolkitListResponse` drops the
       * response's `next_cursor` before any caller sees it. So a catalogue of exactly this many
       * apps and one with more of them answer identically here, and there is no second request that
       * could tell them apart.
       *
       * COMMITTED AS COMPLETE IT WOULD BE CACHED AS COMPLETE, which is what makes this worse than
       * one short answer. The fragment is held for ten minutes and served to both callers, so an
       * administrator searching for an app past the cut is told nothing matched, and the enable
       * route — which checks a slug against this same directory — tells them a real app "is not an
       * app Composio lists". Thrown from inside the fetch so the failure is never the thing that
       * gets held: `listApps` drops an entry whose request rejected.
       */
      throw new BrokerRefusalError(
        `Composio answered with ${toolkits.length} apps, which is the largest page this deployment's @composio/core can ask for, so there may be more that it cannot see. A partial directory is not shown, because an app missing from it reads exactly like an app Composio does not publish.`,
      );
    }

    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      /*
       * Each absence becomes the value that reads honestly on an administrator's screen. An empty
       * description shows as no description; a null logo is the field's documented way of saying
       * the vendor published none, which renders as a gap rather than as a broken image.
       *
       * The categories are the DISPLAY names rather than the slugs, because this list is read by a
       * person choosing an app and "Productivity" is what they are choosing by.
       *
       * A MISSING COUNT BECOMES ZERO, WHICH IS THE ONE IMPERFECT ANSWER HERE. `actionCount` is a
       * number and the shape offers no way to say "not published", so a toolkit that publishes no
       * count reads as an app with no actions. It is the conservative direction — it understates
       * the size of a change rather than overstating it — and Composio publishes a count for every
       * toolkit measured, so this is a guard against the vendor rather than a routine case.
       */
      description: toolkit.meta.description ?? "",
      logo: toolkit.meta.logo ?? null,
      categories: (toolkit.meta.categories ?? []).map(
        (category) => category.name,
      ),
      actionCount: toolkit.meta.toolsCount ?? 0,
    }));
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
    /**
     * The catalogue, from memory where this process asked for it less than ten minutes ago.
     *
     * BOTH CALLERS READ THE SAME HELD ANSWER, AND THE SECOND OF THEM IS THE INTERESTING ONE. The
     * search route filters the directory in this process, so caching it is what stops a debounced
     * search field from pulling a few hundred rows once per term. The enable route then reads the
     * directory again to check that the slug it was handed is one Composio lists, and that read
     * comes out of the same cache — which is the right answer rather than a concession, because
     * the slug being checked is one this deployment handed the browser out of THIS cache moments
     * earlier. The check exists to refuse a slug the catalogue never published — a request composed
     * by hand, or a row left over from a url somebody edited — and a ten-minute-old catalogue
     * settles that question exactly as well as a fresh one. The case it gives up is an app Composio
     * withdrew within the window, whose cost is one `mcp_servers` row for an app that answers
     * nothing, removable on the page that added it; the case it buys is that pressing Add does not
     * re-read a catalogue the picker just read.
     *
     * A FAILURE IS NEVER HELD. The entry is dropped when its request rejects, so a vendor that
     * refused once is asked again by the next caller rather than refusing from memory for ten
     * minutes — the failures here are an unset or wrong API key and Composio being down, and the
     * first two are fixed by an operator who then presses the button again, which must be allowed
     * to work. The callers already sharing that one in-flight request do share its failure, which
     * is the truth about their request: they asked while it was being answered.
     *
     * THERE IS NO INVALIDATION, AND THE DESIGN ASKED FOR ONE. It wanted the directory "refreshable
     * by an explicit reload", and that is not built: the lifetime above is the whole of the
     * freshness story. Nothing in this deployment reloads a catalogue today — no page, route or job
     * has such a control — so the method would have no caller, and an invalidation API with no
     * caller is an untested path that reads like a guarantee. The moment a reload button exists,
     * this is where it attaches.
     */
    async listApps(): Promise<BrokerApp[]> {
      const held = heldDirectory;
      if (held && now() - held.at < DIRECTORY_TTL_MS) return copyOf(held.apps);

      /*
       * Stamped when the request goes out rather than when it comes back, so a slow catalogue is
       * held for slightly less than the full window rather than for the window plus its own
       * latency. Written into the slot before it is awaited, which is what a concurrent caller
       * finds.
       */
      const entry = { at: now(), apps: fetchDirectory() };
      heldDirectory = entry;
      /*
       * The drop on failure, registered here rather than written as a try/catch around an await so
       * that this method hands every caller the one shared promise. `heldDirectory === entry`
       * because a later request may already have replaced this one, and clearing that would throw
       * away a good answer over an old failure.
       */
      entry.apps.catch(() => {
        if (heldDirectory === entry) heldDirectory = null;
      });
      return copyOf(entry.apps);
    },

    async ensureAuthConfig({ toolkit, name }): Promise<void> {
      /*
       * IDEMPOTENT BY LOOKING FIRST, because a second config is not a duplicate — it is a split.
       * A person's existing connection is created against one particular auth config, so creating
       * another and connecting the next person to that leaves two populations of connections for
       * one app, and removing "the" config later drops half of them.
       *
       * THE LOOK IS FOR ONE THIS DEPLOYMENT MADE, WHICH IS NARROWER THAN "ANY". It used to be any,
       * and the two ways that was wrong pull in opposite directions. A disabled config of ours was
       * invisible to the listing, so this created the very second config it exists to prevent — and
       * then `authorize` refused, because it looked with the same blind listing and found the app
       * had no config at all. A config an operator made by hand, meanwhile, satisfied the check and
       * this created nothing, leaving every later decision here pointed at an object nobody here
       * chose. Asking for our own answers both: the disabled one counts, and somebody else's does
       * not.
       *
       * WHICH MEANS AN APP CAN END UP WITH TWO CONFIGS, ONE OF THEM SOMEBODY ELSE'S, and that is
       * the intended outcome rather than a tolerated one. Adopting a hand-made config would have
       * this deployment mint people's connections against scopes and tool restrictions it cannot
       * see, and delete it when the app is removed. A config of our own, named, is the thing every
       * decision in this file can actually reason about.
       *
       * This is a read followed by a write and therefore not atomic: two administrators pressing
       * enable at the same instant can both find nothing and both create. Composio offers no
       * create-if-absent, so the window is the vendor's rather than this deployment's, and the
       * cost of losing that race is a spare config rather than a lost connection — spare rather
       * than orphaned, because both carry the suffix and `deleteAuthConfig` takes every one of
       * ours.
       */
      const existing = await configsMadeHere(toolkit);
      if (existing.length > 0) return;

      await vendor.authConfigs.create(toolkit, {
        type: "use_composio_managed_auth",
        name: `${name} ${CONFIG_SUFFIX}`,
      });
    },

    async deleteAuthConfig(toolkit): Promise<void> {
      /*
       * EVERY CONFIG OF OURS, AND NOTHING THAT IS NOT OURS.
       *
       * This used to delete whichever row the vendor happened to return first, on the reasoning
       * that {@link ComposioBroker.ensureAuthConfig} creates at most one, so a second one must be
       * somebody's dashboard work and must be left alone. The reasoning was right and the code did
       * the opposite of it: with no test of the name, "the first row" is as likely to BE the
       * hand-made config — deleting it, and with it every account anybody had connected against it.
       * Reading the name inverts that. Anything without the suffix is untouched whatever order it
       * arrives in, and everything with it goes, which is also the only way the spare config from a
       * lost enable race is ever cleaned up.
       *
       * QUIET WHERE THERE IS NOTHING OF OURS TO DELETE, because removing an app has to be able to
       * happen twice. An app can be removed, re-enabled and removed again, two administrators can
       * press the button together, and an app enabled before this deployment created configs at all
       * has none to drop. In every one of those the end state is the one that was asked for, so a
       * throw would report a failure while the caller got exactly what they wanted.
       */
      const ours = await configsMadeHere(toolkit);
      const refused = await askForEach(ours, (config) =>
        vendor.authConfigs.delete(config.id, { revoke_on_delete: true }),
      );
      if (refused.length > 0) {
        /*
         * LOUD, because the caller is `removeServer` and the thing it is in the middle of is taking
         * an app away from everybody. A config left standing is a live grant that the removal was
         * supposed to end, and the app's row is deleted after this returns — so a swallowed failure
         * here is the one state nothing in this deployment can find again. The count is the whole
         * message: an operator who can see that one of two configs went knows that pressing remove
         * again finishes the job rather than repeating it.
         */
        throw new BrokerRefusalError(
          `Composio removed ${ours.length - refused.length} of this deployment's ${ours.length} authorization configs for ${toolkit} and refused the rest, so the app has not been fully withdrawn. Removing it again asks only for what is left.`,
          { cause: refused[0] },
        );
      }
    },

    async authorize({
      userId,
      toolkit,
      returnUrl,
    }): Promise<{ redirectUrl: string }> {
      /*
       * THE CONFIG THIS DEPLOYMENT ALREADY MADE, AND NO SECOND ONE MADE HERE.
       *
       * `ensureAuthConfig` creates it when an administrator enables the app, which is what makes
       * this a read. Creating one here instead would mint it at the moment somebody presses
       * Connect, unnamed for this deployment and invisible in the dashboard until the first person
       * happened to try — and where a config already existed for an app enabled twice, a second
       * one would split one app's connections across two configs, so removing "the" config later
       * would drop half of them.
       *
       * NONE IS A STATE WITH A REMEDY, NOT A NULL TO WORK AROUND. It is the app enabled before
       * this deployment created configs at all, or a config deleted by hand in Composio's
       * dashboard. Neither is something a person pressing Connect can fix, so the sentence names
       * the app and the administrator's step rather than leaving them at a link that would attach
       * their account to a configuration nobody here chose.
       *
       * AND "NONE" MEANS NONE OF OURS, which is the correction. The read used to take whichever row
       * the vendor returned first, so an app whose only config was one an operator built by hand
       * read as ready and this minted somebody's connection against it — scopes this deployment
       * cannot see, tool restrictions it cannot read, and an object it must not delete. A
       * connection is a lasting attachment to whatever config it was made against, so guessing here
       * is not a guess that can be corrected later.
       */
      const ours = await configsMadeHere(toolkit);
      if (ours.length === 0) {
        throw new BrokerRefusalError(
          `This deployment has no authorization config at Composio for ${toolkit}, so there is nothing to connect an account against. An administrator removing the app on its Plugins page and adding it again creates one.`,
        );
      }

      /*
       * A DISABLED CONFIG IS NOT A CONFIG TO CONNECT AGAINST, and it is now visible enough to say
       * so. The listing asks for disabled configs — it has to, or the creation above duplicates one
       * — which means this is the first read that can meet one. A link minted against it does not
       * work, so sending a person to the vendor would spend their consent and end with nothing
       * attached; and nothing they can do from the page they are on changes it, because enabling a
       * config happens in Composio's dashboard.
       *
       * THE FIRST OF SEVERAL, WHICH IS A CHOICE AND NOT AN ACCIDENT. More than one enabled config
       * of ours means a lost enable race, and both are equally ours and equally valid. What
       * mattered about the old "first row" was that the order was the vendor's and the next caller
       * could get a different one; the listing is sorted on the id, so this is the same config for
       * every person and for the removal that later drops all of them.
       */
      const config = ours.find((held) => held.status === "ENABLED");
      if (!config) {
        throw new BrokerRefusalError(
          `Every authorization config this deployment holds at Composio for ${toolkit} is disabled, so a connection begun against one could not complete. An administrator can enable it in Composio's dashboard, or remove the app on its Plugins page and add it again.`,
        );
      }

      /*
       * THE RETURN ADDRESS IS THE WHOLE POINT OF THIS CALL, and it is the caller's rather than
       * this file's: the adapter knows Composio, and where a person belongs afterwards is a fact
       * about this deployment's own pages. It is never logged and never quoted in the refusal
       * below, for the reason the url itself is not.
       *
       * NO `allowMultiple`, WHICH LEAVES THE VENDOR ENFORCING THE RULE THIS DEPLOYMENT ALREADY
       * STATES. One person holds one account per app here, because the call that runs an action
       * names the person and not the account — so with two accounts attached, which mailbox a Bot
       * reads would be Composio's choice and nothing here could say which one it had been. The
       * route refuses a second connection before it ever reaches this method, and that refusal is
       * the sentence a person reads; this is the same rule one layer further down, where the
       * vendor is the only party that can still see an account this deployment's rows have lost
       * track of. `toolkits.authorize` passed `allowMultiple: true` unconditionally — the SDK
       * calls it a "magic function" for exactly that — which is the opposite of what this
       * deployment wants.
       */
      const request = await vendor.connectedAccounts.link(userId, config.id, {
        callbackUrl: returnUrl,
      });
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
        throw new BrokerRefusalError(
          `Composio began a connection to ${toolkit} but answered with no page to visit, so there is nothing to send this person to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.`,
        );
      }
      return { redirectUrl };
    },

    async isConnected({ userId, toolkit }): Promise<boolean> {
      return (await accountsFor(userId, toolkit, CONNECTED)).length > 0;
    },

    async revoke({ userId, toolkit }): Promise<boolean> {
      /*
       * THE ANSWER IS WHAT WAS ASKED FOR, not whether the call threw. `false` here means there was
       * nothing to withdraw, which is what the audit trail's `vendorRevocationRequested` is for: a
       * reader has to be able to tell an account this deployment acted on from one that outlives it
       * somewhere else.
       *
       * ASKED FOR, RATHER THAN DONE, AND THE FIELD IS NAMED FOR THAT. The delete carries
       * `revoke_on_delete`, which is what turns it from a record-keeping soft-delete into an actual
       * withdrawal — and what it starts is a background job the vendor gives no supported way to
       * poll. So the account is gone at the broker by the time this returns and nothing here can
       * call with it again; whether Google has torn up the refresh token happens afterwards. `true`
       * claims exactly that much. See {@link ComposioVendor} for the two declarations this rests on.
       *
       * EVERY ACCOUNT, not the first, and in every state that could still be a grant. One person
       * can hold more than one account for one app — two mailboxes, or a stale account beside a
       * fresh one, or a shared account beside their own — and each of them is access this
       * deployment's calls could run under. See {@link REVOCABLE} for why the listing here is wider
       * than the one behind `isConnected`.
       */
      const accounts = await accountsFor(userId, toolkit, REVOCABLE);
      const refused = await askForEach(accounts, (account) =>
        vendor.connectedAccounts.delete(account.id, { revoke_on_delete: true }),
      );

      if (refused.length > 0) {
        /*
         * A PARTIAL WITHDRAWAL IS A FAILURE AND NOT A `true`, and the reason is the row this throw
         * protects. `store.ts` revokes and only then deletes the `composio_connections` row, which
         * is the only thing in this deployment that names which app this person connected. Answer
         * `true` here on a partial and that row is deleted, the trail records a disconnection, and
         * the account this call could not end is left live with nothing pointing at it — the exact
         * state the store's revoke-before-delete order exists to make impossible. Throwing leaves
         * the row standing, so pressing disconnect again is a second attempt with everything the
         * first one had, and the accounts already gone are no longer in the listing, so the retry
         * converges rather than repeating.
         *
         * WHICH IS ALSO WHY IT IS NOT A `true` WITH A GRUMBLE. Nothing was disconnected in the
         * sense the person asked about: their app still answers. The count is in the sentence
         * because "some of your accounts were withdrawn" is the one thing a reader cannot work out
         * for themselves, and the vendor's own error is kept as `cause` for whoever is reading a
         * log rather than a page.
         */
        throw new BrokerRefusalError(
          `Composio withdrew ${accounts.length - refused.length} of this person's ${accounts.length} accounts for ${toolkit} and refused the rest, so their access to it has not ended. Disconnecting again asks only for the accounts that are left.`,
          { cause: refused[0] },
        );
      }

      return accounts.length > 0;
    },
  };

  return { actions, broker };
}

/**
 * The lines that turn this deployment's API key into a vendor client.
 *
 * Everything this file decides lives in {@link buildComposioClient}, which is why this function has
 * no decision worth testing: it constructs the vendor and hands it over. The key is a parameter here
 * and a private field of the vendor's client thereafter, and no path out of this module carries it
 * — see the module comment.
 *
 * IT IS NO LONGER ONE LINE, AND THE REASON IS THE TWO DELETES. `Composio` used to satisfy
 * {@link ComposioVendor} whole, passed straight in. It cannot any more: its own `authConfigs.delete`
 * and `connectedAccounts.delete` send a hard-coded empty body and therefore cannot ask for the
 * upstream revocation, which is the difference between ending somebody's access and filing it away.
 * The underlying `@composio/client` takes the parameter, so those two members are satisfied from
 * `getClient()` and the rest from the SDK's own models. A wrapper per member rather than a spread,
 * so that the arrow's own type checks against the shape above — a vendor method whose signature
 * drifted would fail here rather than at the call site.
 *
 * NO NEW IMPORT, WHICH IS WHY THE ONE-IMPORT-SITE RULE SURVIVES THIS. `getClient()` is public on the
 * SDK's own object and the client's types are inferred from it; `@composio/client` is not named
 * anywhere under `server/src`, so a version bump still has exactly this file to be read against.
 */
export function createComposioClient(apiKey: string): {
  actions: ComposioActions;
  broker: ComposioBroker;
} {
  const composio = new Composio({
    apiKey,
    // Their default telemetry installs its own interrupt handlers, and this is a self-hosted
    // product whose operator never opted into a third party's analytics.
    allowTracking: false,
    // Both default the other way, so both have to be said. The version check reaches npm for the
    // SDK's latest release as the client is constructed, and a deployment's boot must not depend
    // on the vendor's release feed.
    disableVersionCheck: true,
  });
  const client = composio.getClient();

  return buildComposioClient({
    tools: composio.tools,
    toolkits: composio.toolkits,
    authConfigs: {
      list: (query) => composio.authConfigs.list(query),
      create: (toolkit, options) =>
        composio.authConfigs.create(toolkit, options),
      delete: (id, params) => client.authConfigs.delete(id, params),
    },
    connectedAccounts: {
      list: (query) => composio.connectedAccounts.list(query),
      link: (userId, authConfigId, options) =>
        composio.connectedAccounts.link(userId, authConfigId, options),
      delete: (id, params) => client.connectedAccounts.delete(id, params),
    },
  });
}
