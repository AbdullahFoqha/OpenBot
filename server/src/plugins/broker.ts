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
};

/**
 * What this deployment needs of Composio's broker, and nothing more.
 *
 * A NARROW PROJECTION RATHER THAN THEIR CLIENT, for the reason the transport's `ComposioActions` is
 * one: six methods is a shape a test satisfies with an object literal, so every test about
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
  ensureAuthConfig(config: { toolkit: string; name: string }): Promise<void>;
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
 * `COMPOSIO_API_KEY` is the documented default, and the whole brokered surface is absent by design
 * where it is unset. It is a thrown class rather than a null answer because the broker's methods
 * answer apps, booleans and urls, and there is no value in any of those shapes that means "nobody
 * was asked" — an empty app list is indistinguishable from a catalogue outage, and `false` from
 * {@link ComposioBroker.isConnected} is a positive claim about somebody's account.
 *
 * The setting is named in the message because the message is the whole remedy: an operator reading
 * it needs the name of the variable to set, and nothing else about this deployment will tell them.
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
      "Composio is not configured for this deployment, so nothing was asked. Set COMPOSIO_API_KEY to make the brokered apps available; until it is set, no Composio surface appears anywhere in the product.",
    );
    this.name = "BrokerUnconfiguredError";
  }
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
