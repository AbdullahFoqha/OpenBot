/**
 * What openbot needs of Composio the BROKER, as against Composio the transport.
 *
 * `./composio` is about calling an action once an app is connected. This file is about everything
 * that has to be true before that: which apps exist to choose from, which of them this deployment
 * has an auth config for, whose account is attached to one, and how a person attaches or detaches
 * theirs. Two different questions, so two different projections rather than one wide client.
 *
 * IT IMPORTS NOTHING, AND THAT IS THE POINT OF IT. Not `@composio/core`, not a type from elsewhere
 * in this tree. Everything below is a name for a shape, so the vendor's package stays confined to
 * the adapter that implements {@link ComposioBroker} — one file, replaceable, and the only place a
 * version bump can reach. A module that named the vendor's types here would put their package on
 * the import graph of every test that touches enablement.
 */

/**
 * The schemes whose secret a PERSON holds and types in, rather than one anybody registers.
 *
 * WRITTEN ONCE AND READ TWICE, BECAUSE A SECOND DECLARATION IS A WAY FOR THE TWO TO DISAGREE. The
 * list is the fact and {@link FieldScheme} is derived from it, so the names the guard tests and the
 * names the type admits cannot come apart. A hand-written union beside a hand-written array is the
 * same set stated twice, and a member added to one of them and not the other typechecks perfectly.
 *
 * AND THE DISAGREEMENT FAILS OPEN, which is why it is worth a derivation rather than a comment
 * asking the next person to keep both in step. {@link isFieldScheme} would answer false for a scheme
 * the type calls valid, and an app whose secret a person types would be read as one nobody types —
 * sent down the consent path, to a vendor screen that has nothing to ask them for.
 */
const FIELD_SCHEME_NAMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
] as const;

export type FieldScheme = (typeof FIELD_SCHEME_NAMES)[number];

/**
 * Whether a scheme recorded on a row is one whose secret a person types.
 *
 * Takes the column's own type — `string | null` — rather than a `FieldScheme`, because every
 * caller is asking ABOUT a recorded value, and a signature demanding the answer first would push
 * the same `includes` into four call sites.
 */
export function isFieldScheme(scheme: string | null): scheme is FieldScheme {
  return (
    scheme !== null &&
    (FIELD_SCHEME_NAMES as readonly string[]).includes(scheme)
  );
}

/**
 * One value Composio wants from the person connecting, as Composio itself describes it.
 *
 * Every field here is published per app rather than guessed: `is_secret` says which one to mask,
 * and the description is written for the person filling it in ("Your Firecrawl API key, a token
 * starting with fc-"). `name` is sent back on the wire verbatim and is never shown.
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
 * How this deployment would connect somebody to an app — the one fact everything else reads.
 *
 * Derived once from the catalogue, recorded on the app's row at enable time, and read by the
 * picker (which hides `unsupported`), by the enable path (which creates the config this names, or
 * none) and by the connect screen (which draws a link or a form). Deriving it twice is how a
 * single hard-coded choice came to leak into every app in the first place.
 */
export type BrokerConnection =
  | { kind: "consent" }
  | { kind: "self-registering" }
  | { kind: "fields"; authScheme: FieldScheme }
  | { kind: "no-auth" }
  | { kind: "unsupported"; reason: string };

/**
 * One app in the catalogue, as much of Composio's toolkit listing as anything here reads.
 *
 * `logo` is nullable because the vendor publishes none for some toolkits, and an administrator
 * picking from a list of a few hundred apps is better served by a missing image than by a broken
 * one.
 */
export type BrokerApp = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /**
   * How many actions the app publishes, shown BEFORE anybody enables it.
   *
   * Because the size is the decision. Enabling an app writes every one of its actions into
   * `mcp_tools` and puts them in front of a model, so the difference between an app with six
   * actions and one with sixty-three is the difference between a small addition and a rewrite of
   * what the model sees. An administrator who learns the number only after enabling has already
   * made the choice this field exists to inform.
   */
  actionCount: number;
  /** How somebody would connect to it. See {@link BrokerConnection}. */
  connection: BrokerConnection;
};

/**
 * What this deployment needs of Composio's broker, and nothing more.
 *
 * A NARROW PROJECTION RATHER THAN THEIR CLIENT, for the reason the transport's `ComposioActions` is
 * one: nine methods is a shape a test satisfies with an object literal, so every test about
 * enablement, connection and revocation is a test about this deployment's logic and none of them
 * reaches the network. The vendor's client would drag its constructor, its retries and its schemas
 * into each of those tests, and the first thing every one of them would do is find a way not to
 * dial.
 */
export type ComposioBroker = {
  /** Every app the catalogue offers, which is what an administrator chooses from. */
  listApps(): Promise<BrokerApp[]>;
  /**
   * Make sure this deployment has an auth config for the app, and say nothing if it already did.
   *
   * IDEMPOTENT, AND CALLED AT ENABLE TIME. An auth config is per-deployment rather than per-person —
   * it is the thing a person's connection is then created against — so the natural moment to create
   * it is when an administrator enables the app, and the natural number of times that moment
   * happens is "more than once": an app can be enabled, removed and enabled again, and two
   * administrators can press the button together. An implementation that created a second config
   * on the second call would leave a person's existing connections pointing at the first one.
   */
  ensureAuthConfig(config: {
    toolkit: string;
    name: string;
    /**
     * Which flow this app was resolved to, which decides what is created and whether anything is.
     *
     * Passed in rather than read here, because the caller has already resolved it from the
     * catalogue row the administrator chose, and a second derivation is a second answer.
     */
    connection: BrokerConnection;
  }): Promise<void>;
  /**
   * Drop this deployment's own auth configs for the app, which is what removing an app has to do.
   *
   * ITS OWN, WHICH IS A NARROWER PROMISE THAN "THE APP'S". An auth config lives in an operator's
   * Composio dashboard beside any they made by hand there, and removing an app from these pages is
   * not a mandate to delete somebody's dashboard work. An implementation has to be able to tell the
   * two apart before it deletes anything, and to leave anything it cannot claim.
   */
  deleteAuthConfig(toolkit: string): Promise<void>;
  /**
   * Begin one person's connection to one app, answering the url they have to visit.
   *
   * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to this person's
   * connection, so it is neither stored nor logged nor put in an audit row: it is handed to the
   * browser that asked for it and then forgotten. A redirect url in a log is somebody else's
   * mailbox for as long as it stays valid.
   */
  authorize(request: {
    userId: string;
    toolkit: string;
    /**
     * Where the vendor sends this person once the consent screen is done with them.
     *
     * REQUIRED, BECAUSE A CONSENT WITH NO RETURN LEG STRANDS SOMEBODY. Without it the flow ends on
     * Composio's own hosted page: the person has consented, nothing here knows it, and the only
     * way back is for them to find this deployment again by hand. An optional field would have
     * made that the default for whichever call site forgot to pass one, which is exactly the state
     * this parameter exists to end.
     *
     * IT IS AN ADDRESS THIS DEPLOYMENT BUILT AND NEVER ONE A CALLER CHOSE. Whoever names it names
     * where a person lands holding a just-completed consent, so a value taken from a request body,
     * a query or a header would be an open redirect with a consent screen in front of it. The one
     * caller builds it from the deployment's configured app URL and narrows the page within it to
     * a known name, the same way this repository's own OAuth `returnTo` is narrowed.
     *
     * AND `string` IS THE WHOLE OF WHAT THE TYPE CAN PROMISE, WHICH IS WHY
     * {@link brokerReturnUrl} EXISTS. "Required" above means "not optional", and `""`, `"   "` and
     * `openbot.example.com/settings/...` are all required values: they satisfy this field and
     * reach the vendor as a callback nobody returns through. Nor can a narrower type fix it — the
     * address is assembled at run time from an environment variable, so the caller holds a
     * `string` and every type an ordinary `string` is assignable to admits the empty one too. The
     * promise this comment makes is therefore kept by the guard below, and a caller hands its
     * address through that before it hands it here.
     */
    returnUrl: string;
  }): Promise<{ redirectUrl: string }>;
  /** Whether this person currently has an account attached to this app at the vendor. */
  isConnected(request: { userId: string; toolkit: string }): Promise<boolean>;
  /**
   * Ask the vendor to withdraw this person's grant, answering WHAT WAS ACTUALLY ASKED.
   *
   * True where this deployment found at least one account and asked the vendor to revoke it, false
   * where there was none to withdraw — not "the call did not throw". The audit trail records that
   * answer as `mcp.account_disconnected`'s `vendorRevocationRequested`, and the whole value of that
   * field is that a reader can tell an account this deployment acted on from one that outlives it
   * somewhere else. A boolean that always said true would make the row a worse record than no row.
   *
   * "REQUESTED" IS AS FAR AS ANY IMPLEMENTATION CAN HONESTLY GO, and the name of the field says so
   * because the first one did not. This boolean used to be called `vendorRevoked` and was written
   * by an adapter that soft-deleted the account and asked for no revocation at all, so a trail that
   * said a grant had been withdrawn recorded one that was still live at Google. What a broker can
   * promise synchronously is that the account is gone at the broker — nothing here can call with it
   * again — and that the upstream withdrawal was asked for; whether the provider honoured it
   * happens afterwards, out of sight of the call that asked. A field that claimed the stronger
   * thing would be the one row in the trail nobody could rely on.
   *
   * A PARTIAL ASK IS A FAILURE RATHER THAN A TRUE. One person can hold more than one account for
   * one app, and an implementation that ended some of them and could not end the rest has not
   * disconnected anybody: their app still answers. It must throw, so that the row this deployment
   * holds — the only thing that names which app to try again against — is still standing when they
   * press disconnect a second time.
   */
  revoke(request: { userId: string; toolkit: string }): Promise<boolean>;
  /**
   * What this app asks a person to type, as Composio publishes it for the scheme.
   *
   * ASKED OF THE VENDOR RATHER THAN WRITTEN DOWN HERE, which is the whole reason it is a call and
   * not a constant. The fields are per app and they move: a form built from one hard-coded "API
   * key" box is right for Firecrawl and wrong for the app that also wants a workspace subdomain,
   * and wrong quietly — the person fills in what they were shown, a connection is created without
   * the value nobody asked them for, and the first tool call is what discovers it. The `help` on
   * {@link BrokerField} is the vendor's own sentence written for the person filling the box in, and
   * it is worth more than anything this deployment could invent about somebody else's console.
   *
   * THE SCHEME IS PASSED IN RATHER THAN RESOLVED HERE, for the reason {@link
   * ComposioBroker.ensureAuthConfig} takes a connection rather than deriving one: the caller
   * already holds the scheme recorded on the app's row at enable time, and a second derivation is a
   * second answer — a form drawn for `BASIC` in front of a config created for `API_KEY`, whose
   * fields the person cannot fill in because they are not the ones their app has.
   */
  connectionFields(request: {
    toolkit: string;
    authScheme: FieldScheme;
  }): Promise<BrokerField[]>;
  /**
   * Connect this person with the secret they typed, answering the account it made.
   *
   * THE ONE CALL WHOSE IMPLEMENTATION MUST RETHROW WITH NO `cause`, WHICH IS AN INVERSION OF THE
   * STANDING RULE AND SAYS SO ON PURPOSE. The rule `composio-adapter.ts` states and every path here
   * keeps is that a vendor error is never logged and always carried as `cause`, precisely because
   * the object holds the request it was made for and whoever is reading a log rather than a page
   * deserves it. On every other call that request is a link mint or a delete. On this one it is
   * somebody's API key. So this is the single place the rule reverses: read the vendor's sentence
   * through the existing door, then drop the object entirely rather than attach it.
   *
   * WHAT THAT COSTS IS THE DIAGNOSTIC TRAIL ON THE FLOW PEOPLE MOST OFTEN MISTYPE, AND THE COST IS
   * ACCEPTED KNOWINGLY. A key pasted with a newline, a token from the wrong workspace, a secret for
   * the staging tenant — these are the ordinary failures here, and they are the ones this leaves
   * nothing behind about. What an operator gets instead is Composio's own sentence and the request
   * id inside it, which is enough to ask the vendor about that attempt and not enough to rebuild it
   * here. A `cause` that made the next mistyped key easier to explain would put every correctly
   * typed one in a log for as long as the log is kept.
   *
   * THE `accountId` IS ANSWERED SO A CALLER CAN UNDO EXACTLY THIS ACCOUNT. A connection made from
   * typed fields is verified before it is kept, and a verification has to be able to take back the
   * thing it just made and nothing else. {@link ComposioBroker.revoke} is the wrong instrument for
   * that — it ends every account this person holds for the app, which is right for somebody ending
   * their access and wrong for a step undoing its own work. The two differ exactly when the local
   * row and Composio have drifted apart: the person already had a connection that works, this
   * attempt made a second one, the verification failed — and a sweep there takes down the
   * connection that was working. See {@link ComposioBroker.revokeAccount}.
   */
  connectWithFields(request: {
    userId: string;
    toolkit: string;
    authScheme: FieldScheme;
    /**
     * What the person typed, keyed by the `name` {@link BrokerField} was published under.
     *
     * THE ONLY SECRET THAT CROSSES THIS SEAM, which is what the no-`cause` rule above is about. The
     * names are sent back on the wire verbatim and are never shown; the values are the person's own
     * credential and belong in no message, no log and no audit row, for the reason the connect url
     * does not.
     */
    values: Record<string, string>;
  }): Promise<{ accountId: string }>;
  /**
   * End ONE account by id, and ask for the grant behind it to be withdrawn too.
   *
   * ONE, WHICH IS THE WHOLE DIFFERENCE FROM {@link ComposioBroker.revoke}. That method sweeps every
   * account a person holds for an app, because what it serves is a person ending their access to
   * it. This serves a caller undoing an account it just made, and the id is the whole of what it
   * names — nothing is listed, nothing is matched, and no account this call was not handed can be
   * reached by it. The narrower instrument exists because the wider one is destructive in precisely
   * the case a verification runs into: a working connection standing beside a failed second
   * attempt.
   *
   * WITH `revoke_on_delete`, WHICH IS WHAT MAKES IT A WITHDRAWAL RATHER THAN A RECORD-KEEPING
   * SOFT-DELETE. Without that flag the account stops being visible to this deployment and the
   * credential at the far end stands — which is the exact state {@link ComposioBroker.revoke}
   * records this deployment once claiming as a revocation, and it is worse here than there: the
   * secret left live is one a person typed minutes ago into a form that then told them the
   * connection had not been kept.
   *
   * NO BOOLEAN, BECAUSE THERE IS NOTHING TO COUNT. `revoke` answers what it found because it
   * searches for it; this is handed the id of an account created moments earlier by the call that
   * answered it, so "there was nothing there" is not an outcome a caller chooses between — it is a
   * failure, and it throws like any other.
   */
  revokeAccount(accountId: string): Promise<void>;
};

/**
 * A refusal this deployment authored, whose own message is the whole explanation.
 *
 * THE ROUTE CANNOT TELL AN AUTHORED REFUSAL FROM A VENDOR OUTAGE WITHOUT A TYPE, which is the only
 * reason this class exists. `routes.ts` answers a thrown broker error by reaching into it for the
 * vendor's own sentence and, finding none, saying what a vendor failure deserves to be told —
 * "Composio said nothing about why, check the key, check their status". That advice is wrong twice
 * over for a sentence this deployment wrote itself: Composio was reachable, answered, and the thing
 * that has to change is here rather than there. Every refusal raised below this line is written for
 * the person who will read it and names the step that fixes it, so the one correct thing a route
 * can do with it is pass it through.
 *
 * WHICH MAKES THE CLASS A PROMISE ABOUT THE MESSAGE rather than a category of failure. Nothing is
 * raised as one of these unless its sentence is safe to show anybody who could have made the
 * request — no url that is a bearer capability, no key, no vendor object — because that is exactly
 * what raising it asks the route to do. A failure this file cannot explain stays a plain `Error`,
 * so the route keeps reaching for the vendor's own words instead of inventing better ones.
 */
export class BrokerRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerRefusalError";
  }
}

/**
 * The state a deployment with no Composio key is in, raised rather than returned.
 *
 * A STATE, NOT A FAULT, in the same sense `./composio`'s unconfigured listing is one: unset
 * `COMPOSIO_API_KEY` is the documented default, and where it is unset there is nothing to connect,
 * nothing to grant and no brokered tool for a Bot to call — what is left on screen is one row that
 * goes nowhere, under More apps on the admin Plugins page, naming the setting rather than hiding
 * the feature. It is a thrown class rather than a null answer because the broker's methods
 * answer apps, booleans and urls, and there is no value in any of those shapes that means "nobody
 * was asked" — an empty app list is indistinguishable from a catalogue outage, and `false` from
 * {@link ComposioBroker.isConnected} is a positive claim about somebody's account.
 *
 * The setting is named in the message because the message is usually the whole remedy: an operator
 * reading it needs the name of the variable to set, and the one other place this deployment names
 * it is that row on the admin Plugins page, which somebody meeting this error through the API may
 * never have seen.
 *
 * A {@link BrokerRefusalError} BECAUSE IT IS THE ORIGINAL ONE. It was the only authored refusal a
 * route could recognise when this file had one class, and it is a refusal of exactly that kind: a
 * sentence written here, naming the step that fixes it. Keeping its own name is what lets a caller
 * ask for this one state in particular — `store.ts` raises it by name, and `routes.ts` sends its
 * message where no call was made at all.
 */
export class BrokerUnconfiguredError extends BrokerRefusalError {
  constructor() {
    super(
      "Composio is not configured for this deployment, so nothing was asked. Set COMPOSIO_API_KEY to make the brokered apps available; until it is set there is nothing to connect, nothing to grant and no Composio tool for a Bot to call, and the admin Plugins page shows one row under More apps that goes nowhere.",
    );
    this.name = "BrokerUnconfiguredError";
  }
}

/**
 * A return address that could not bring anybody back, refused before a consent is spent on it.
 *
 * ITS OWN CLASS BECAUSE ITS REMEDY IS ITS OWN. Every other refusal in this file is about Composio —
 * a key that is not set, a config this deployment never made, a consent the vendor answered with no
 * page. This one is about this deployment's own address for itself, and the person who can act on it
 * is an operator with `OPENBOT_APP_URL` in front of them. A caller that could not tell the two apart
 * would send somebody to check a Composio key that is perfectly fine.
 *
 * A {@link BrokerRefusalError} because it keeps that class's promise about the message: the sentence
 * is written here, names the step that fixes it, and carries no url. Which matters more than usual
 * for this one — the value it is refusing is the thing a bad message would be tempted to quote, and
 * an address is the half of a connect link that says which deployment and which person it is for.
 */
export class BrokerReturnUrlError extends BrokerRefusalError {
  constructor(message: string) {
    super(message);
    this.name = "BrokerReturnUrlError";
  }
}

/**
 * The address a person comes back to, checked to be one, or a refusal instead of a link.
 *
 * BEFORE THE CONSENT RATHER THAN AFTER IT, which is the entire value of doing this at all. Past this
 * point the next thing that happens is a vendor page and somebody granting a third party access to
 * their mailbox; a callback that is not a callback is only discovered once they have, by which time
 * the thing that would tell them what went wrong is on the deployment they can no longer reach. So a
 * caller that has no usable address gets a refusal in place of a link, and nobody spends a consent.
 *
 * TWO REFUSALS, BECAUSE THEY ARE TWO DIFFERENT MISTAKES. An empty address is a caller that built
 * none — the guard in front of this one did not run, or ran against the wrong value. An address that
 * is not a web page is a configured one that cannot work: `OPENBOT_APP_URL` set to
 * `openbot.example.com`, which no browser can resolve from Composio's origin, or to `localhost:3001`,
 * where `localhost:` is read as the scheme. Both are reachable from the settings this deployment
 * actually ships — the variable is an environment string and nothing between it and the vendor looks
 * at it — and both end with the same person on the same hosted page with nowhere to go.
 *
 * IT NAMES THE SETTING AND NOT THE VALUE. The setting is the remedy, and it is the same one whether
 * the address arrived empty or malformed; the value is a page address for one person's connection
 * and belongs in no message, no log and no audit row, for the reason the connect url does not.
 *
 * WHAT COMES BACK IS THE ADDRESS THAT WAS CHECKED, WHICH IS NOT ALWAYS THE STRING THAT WENT IN. The
 * check reads a parsed address: the emptiness test trims, and parsing drops the spaces and control
 * characters a URL cannot contain — so ` https://openbot.test/…`, an address ending in a newline and
 * one with a tab inside its host all satisfy this guard while denoting something else entirely. A
 * version that approved the parsed address and returned the raw one approved nothing: the padding
 * travelled on to Composio as part of the callback, which is the person stranded on a vendor page
 * that this function exists to prevent. Returning what was read is what makes the reading binding.
 *
 * THAT IS A READING OF THE ADDRESS AND NOT A CHOICE ABOUT IT. Where somebody lands holding a
 * just-completed consent is a decision this seam keeps in one place, so the destination is still
 * the caller's; a parsed address names the same place a browser handed the original would have gone
 * — the padding was never part of the destination, only of the string. What this cannot do is guess
 * at an address that means nothing, which is why the branch above refuses rather than repairs: a
 * missing scheme is a setting to fix and not whitespace to drop.
 */
export function brokerReturnUrl(returnUrl: string): string {
  if (returnUrl.trim() === "") {
    throw new BrokerReturnUrlError(
      "This deployment built no address for Composio to send you back to, so the connection was not begun rather than begun with nowhere to land. Set OPENBOT_APP_URL to the address this deployment's pages are served from, and connecting an app will have a return leg.",
    );
  }
  const address = webAddress(returnUrl);
  if (address === null) {
    throw new BrokerReturnUrlError(
      "The address Composio would send you back to is not a web address, so a consent granted there would end on Composio's own page with no way back here. Set OPENBOT_APP_URL to this deployment's own origin including the scheme — https://openbot.example.com rather than openbot.example.com.",
    );
  }
  return address.href;
}

/**
 * The address a browser on somebody else's origin could follow — absolute, and http or https — and
 * null for anything else.
 *
 * It answers with the parsed address rather than a boolean so that the one caller can hand back what
 * was actually examined. A predicate would leave the caller holding only the string it was given and
 * no way to tell it apart from the address that string denotes.
 */
function webAddress(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:"
    ? parsed
    : null;
}

/**
 * The broker failures worth explaining to a reader, and null for every other one.
 *
 * NULL RATHER THAN A FALLBACK SENTENCE, which is the whole reason this is a function instead of an
 * `error.message` read at each call site. The only failures whose message this module can vouch for
 * are the ones raised as a {@link BrokerRefusalError}, which is a promise its subclasses make about
 * what they say; a socket that hung up, a 500 from the catalogue and a rate limit are all failures
 * it knows nothing about. A function that answered those with `error.message` would be putting a
 * vendor's object, and whatever it happens to carry, in front of whoever asked.
 *
 * So the caller chooses what to say about a failure it actually has, and this decides only the
 * cases it can decide. The raised error's own message is returned rather than a copy, so there is
 * one wording of each remedy and it lives beside the code that raises it.
 */
export function brokerSentence(error: unknown): string | null {
  return error instanceof BrokerRefusalError ? error.message : null;
}
