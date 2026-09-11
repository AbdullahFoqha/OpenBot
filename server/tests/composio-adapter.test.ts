import { describe, expect, test } from "bun:test";
import { Composio } from "@composio/core";
import {
  BrokerRefusalError,
  brokerSentence,
  type ComposioBroker,
} from "../src/plugins/broker";
import {
  type ComposioActions,
  LISTING_LIMIT,
  vendorSentence,
} from "../src/plugins/composio";
import {
  buildComposioClient,
  createComposioClient,
} from "../src/plugins/composio-adapter";

/**
 * The three facts about the adapter that a type checker cannot settle, asserted with no network.
 *
 * {@link buildComposioClient} takes the vendor OBJECT rather than an API key, and that is the whole
 * reason this file can exist: every test below hands it a literal whose methods record what they
 * were asked and answer from memory, so the adapter's own decisions are what is under test and
 * nothing here dials Composio. A `createComposioClient` that only took a key would have made this
 * file either a live test or no test at all.
 *
 * WHAT IS WORTH ASSERTING IS WHAT IS EASY TO GET SILENTLY WRONG. The mapping of the vendor's fields
 * onto ours is one such thing — a listing that omitted its limit, or a catalogue row that read the
 * wrong key for an action count, both answer plausibly and both are wrong in a way no exception
 * reports. The refusal is the other: it is the one place this adapter is required to NOT make a
 * vendor call, and an implementation that forwarded a mismatch would pass every test that only
 * looked at what came back.
 */

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
function refuse(what: string) {
  return async (): Promise<never> => {
    throw new Error(`${what} should not have been called in this test.`);
  };
}

/**
 * A vendor object whose every method refuses, with the few a test cares about substituted in.
 *
 * The refusals are the point rather than filler. A test about the catalogue that accidentally
 * executed a tool, or one about a refusal that reached the vendor anyway, would otherwise fail on
 * something unrelated — or, worse, pass. Here the unasked-for call names itself.
 */
function fakeVendor(parts: {
  tools?: Record<string, unknown>;
  toolkits?: Record<string, unknown>;
  authConfigs?: Record<string, unknown>;
  connectedAccounts?: Record<string, unknown>;
}) {
  return {
    tools: {
      getRawComposioTools: refuse("tools.getRawComposioTools"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
      ...parts.tools,
    },
    toolkits: {
      get: refuse("toolkits.get"),
      ...parts.toolkits,
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
      ...parts.authConfigs,
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      delete: refuse("connectedAccounts.delete"),
      ...parts.connectedAccounts,
    },
  };
}

/**
 * The page every listing here asks for, WRITTEN OUT rather than imported.
 *
 * AN ASSERTION THAT IMPORTS THE CONSTANT IT IS ABOUT CANNOT FAIL WHEN THAT CONSTANT MOVES, because
 * both sides move together: each `limit` assertion below asked for whatever page the adapter had
 * just decided to ask for, and `LISTING_LIMIT` 1000 -> 20 left all of them passing. The sibling
 * `composio-transport.test.ts` writes its two numbers out for exactly this reason and documents it
 * at length; this file imported one and called it pinned.
 *
 * So the literal lives here, and the imported constant is read in exactly one test below — which is
 * where the argument for the number belongs: 1000 is the vendor's stated page ceiling and therefore
 * the whole listing.
 */
const WHOLE_LISTING = 1000;

/**
 * How many pages of one listing the adapter reads before it refuses, WRITTEN OUT for the reason
 * {@link WHOLE_LISTING} is — and asserted exactly, for a reason of its own.
 *
 * `expect(calls).toBeLessThan(200)` stood against a ceiling of 50. That bound pins nothing: it
 * passes at 50 pages, at 51, at 199, and at any ceiling anybody cares to raise it to short of the
 * test's own runaway stop — which is to say it asserted that the paging terminated and called that
 * an assertion about the ceiling. It was also green over the off-by-one it was the only test in a
 * position to see: the adapter read 51 pages while its refusal said 50, because the ceiling was
 * tested before the page it was counting had been recorded.
 *
 * So the number of pages READ and the number the refusal STATES are both asserted, and both
 * against this literal.
 */
const PAGES_BEFORE_REFUSING = 50;

/** The page this deployment sends somebody back to once the consent screen is done with them. */
const RETURN_URL = "https://openbot.test/settings/connected-accounts/x";

/**
 * What Composio answers a withdrawal it actually performed, returned by every double that performs
 * one.
 *
 * A DOUBLE THAT OMITS THIS IS NOT A DOUBLE OF THE VENDOR. `success` is a REQUIRED field of
 * `ConnectedAccountDeleteResponse` — "indicates whether the connected account was successfully
 * deleted" (`@composio/client` 0.1.0-alpha.76, `resources/connected-accounts.d.ts:7445-7451`) — and
 * every fixture here used to answer `undefined`, which Composio cannot send. That was harmless only
 * for as long as the adapter read nothing off the reply; the moment it started telling a performed
 * delete from a declined one, a fixture answering nothing was a fixture asserting the adapter's
 * behaviour against a reply no vendor produces.
 *
 * SPELLED AT EACH DOUBLE RATHER THAN DEFAULTED IN {@link fakeVendor}, for the reason the refusals
 * there are spelled: the two tests next door hand back `{ success: false }` and `{}` on purpose,
 * and a default would put the interesting answer and the ordinary one at different distances from
 * the reader.
 */
const WITHDRAWN = { success: true };

/**
 * What Composio answers a creation it actually performed, for the reason {@link WITHDRAWN} exists.
 *
 * `transformCreateAuthConfigResponse` builds this answer by reading `response.auth_config.id`
 * (`@composio/core` 0.18.1, `src/utils/transformers/authConfigs.ts:96-106`), so an id is the one
 * thing a created config comes back with. A double answering `undefined` is a double of a reply the
 * vendor cannot send — harmless only for as long as the adapter read nothing off it, which is
 * exactly the state that let a shape drift here report that nothing had been created over a config
 * standing at Composio.
 */
const CREATED = { id: "ac_created" };

/**
 * The three auth configs this file reasons about, named once rather than spelled at each fixture.
 *
 * Two of them are ours and one is an operator's dashboard work, and every decision the adapter
 * makes about an app's configs is a decision about which of the three it is looking at. Naming
 * them is what lets a fixture be written OUT of the order its assertion expects — see {@link MIXED}
 * — instead of being an array whose index quietly carries the answer.
 */
const BY_HAND = { id: "ac_by_hand", name: "Linear", status: "ENABLED" };
const OURS = { id: "ac_ours", name: "Linear (OpenBot)", status: "ENABLED" };
/** The spare from a lost enable race: two administrators both found nothing and both created. */
const OURS_SPARE = {
  id: "ac_ours_spare",
  name: "Linear (OpenBot)",
  status: "ENABLED",
};

/**
 * The gmail config this deployment made, which is what a withdrawal is now allowed to reach.
 *
 * `revoke` READS THE CONFIGS BEFORE IT READS THE ACCOUNTS, which is why every fixture below that
 * withdraws anything answers this listing. The account listing is scoped to the ids that come back
 * from it, so a fixture that did not answer it would be describing a deployment with no config of
 * its own — for which there is, correctly, nothing to withdraw — and every assertion about what the
 * delete was asked would be an assertion about a call that never went out.
 *
 * ITS OWN CONSTANT RATHER THAN {@link OURS}, because the suffix is the whole of what the adapter
 * reads and the rest of the name is the app an administrator typed. A gmail withdrawal answered
 * with a config called "Linear (OpenBot)" would pass, and would leave the one fixture in this file
 * that names the app it is about naming the wrong one.
 */
const OUR_GMAIL = {
  id: "ac_gmail_ours",
  name: "Gmail (OpenBot)",
  status: "ENABLED",
};

/** An operator's own gmail config, carrying no suffix, which is the whole of what tells them apart. */
const BY_HAND_GMAIL = {
  id: "ac_gmail_by_hand",
  name: "Gmail",
  status: "ENABLED",
};

/** That listing as a vendor double, since every withdrawing fixture below needs the same one. */
const ourGmailConfig = async () => ({ items: [OUR_GMAIL] });

/**
 * The three sentences `authorize` can refuse with, told apart by the remedy each one prescribes.
 *
 * `rejects.toThrow(/linear/)` MATCHES ALL THREE, WHICH IS NOT A DETAIL. Deleting the no-config
 * branch outright left this suite at 24 pass / 0 fail, because the call then fell through to the
 * disabled branch and that sentence names the app too. The three remedies are three different acts
 * by three different people — an administrator adding the app again, an operator enabling the
 * config in Composio's own dashboard, and nobody at all because the app is not connected by
 * visiting a page — so a test that cannot tell the sentences apart cannot tell a correct
 * classification from a wrong one, which is the whole thing these refusals exist to get right.
 *
 * Each is the fragment of its own sentence that no other one contains, and each test below asserts
 * its own AND the absence of the others.
 */
const NO_CONFIG_REMEDY =
  /removing the app on its Plugins page and adding it again creates one/;
const DISABLED_REMEDY = /can enable it in Composio's dashboard/;
const NO_PAGE_REMEDY =
  /connected by entering a credential rather than by visiting a page/;

/**
 * The error a call raised, or a failure saying it answered where the test required a refusal.
 *
 * `rejects.toThrow(...)` cannot be followed by a second question about the SAME error — which kind
 * it was, what else its sentence does not say — so every refusal assertion that wanted more than
 * one fact about one throw had to settle for the first. This hands the error over instead.
 *
 * IT TOLD TWO LIES ABOUT ITS OWN FAILURES, and a helper every refusal in this file is read through
 * is the last place a wrong answer about what happened should come from.
 *
 * `null` WAS BOTH ANSWERS AT ONCE. It was the value the resolve arm produced AND a value the reject
 * arm can hand back — `Promise.reject(null)` is a rejection, and a vendor stub or an adapter path
 * that raises a falsy value is exactly the kind of thing the tests below are written to catch — so
 * a call that REFUSED with one was reported as "The call answered where this test requires it to
 * have refused." That sends the reader to look for a missing guard when the guard fired. The two
 * outcomes are now told apart by which arm ran rather than by the value it carried.
 *
 * `undefined` WAS RETURNED AS AN `Error` IT IS NOT. The cast made the type check and nothing else:
 * the caller's very next line reads `.message` off it and the suite fails with the runtime's own
 * "undefined is not an object", which is the phrasing this file's own {@link A_CRASH}
 * exists to flag as a crash wearing a refusal's clothes — raised here, in the helper, about the
 * test rather than about the adapter. A rejection that is not an `Error` has no message to read, so
 * this says so itself instead of handing the caller something that will.
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  type Outcome = { refused: false } | { refused: true; raised: unknown };

  const outcome = await work.then<Outcome, Outcome>(
    () => ({ refused: false }),
    (raised: unknown) => ({ refused: true, raised }),
  );
  if (!outcome.refused) {
    throw new Error(
      "The call answered where this test requires it to have refused.",
    );
  }
  if (!(outcome.raised instanceof Error)) {
    throw new Error(
      `The call refused with ${
        outcome.raised === null ? "null" : typeof outcome.raised
      } rather than with an Error, so there is no message on it for this test to read.`,
    );
  }
  return outcome.raised;
}

/**
 * What a failure must never read like: the name of a method that was not there.
 *
 * AT MODULE SCOPE BECAUSE IT IS THE SAME QUESTION EVERYWHERE, and it is asked of every refusal this
 * file added after the shape sweep: a guard that is missing does not answer politely, it reads a
 * field off `undefined` and hands an administrator a sentence naming a vendor method. A message
 * matching this is a crash wearing a refusal's place in the code.
 *
 * "IS NOT AN OBJECT" IS ANCHORED TO `undefined` AND `null` RATHER THAN LEFT BARE, because the
 * adapter's own sentence for a malformed input schema says "a thing that is not an object cannot be
 * shown as one" — the correct refusal, flagged as a crash by a pattern looking for a fragment of
 * one. The runtime's phrasings are "undefined is not an object (evaluating ...)" and the same with
 * null, so the anchor keeps every crash this caught and stops it catching an authored sentence.
 */
const A_CRASH =
  /is not a function|(?:undefined|null) is not an object|is not iterable|cannot read propert/i;

/**
 * Every sentence one failure carries, its own first and then the ones hanging off it.
 *
 * A COUNT IS A SENTENCE WITH ITS REASONS SOMEWHERE ELSE, which is why a question about what a reader
 * was told cannot always be asked of `message` alone. `revoke` and `deleteAuthConfig` withdraw a SET
 * and make the count their whole message on purpose — it is the part a reader can act on — and hang
 * every refusal the loop met on `cause`, as one error or as an `AggregateError` of them. Asking only
 * the first line there would grade those two methods on a wording that is deliberately not where
 * their detail lives.
 */
function everythingSaidBy(error: unknown, depth = 0): string[] {
  if (!(error instanceof Error) || depth > 4) return [];
  const carried =
    error instanceof AggregateError
      ? error.errors.flatMap((one) => everythingSaidBy(one, depth + 1))
      : [];
  return [
    error.message,
    ...carried,
    ...everythingSaidBy(error.cause, depth + 1),
  ];
}

describe("the page size this file is written against", () => {
  test("the module's ceiling is still the number every assertion here spells out", () => {
    // The one place the imported constant is read. Changing `LISTING_LIMIT` reddens exactly this
    // test, which is where the argument for the number lives, rather than silently moving every
    // assertion in the file to whatever the module has just decided.
    expect(LISTING_LIMIT).toBe(WHOLE_LISTING);
  });
});

describe("listing an app's actions", () => {
  test("the caller's page reaches the vendor, so the vendor's default never applies", async () => {
    const asked: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioTools: async (query: unknown) => {
            asked.push(query);
            return [
              {
                slug: "GMAIL_FETCH_EMAILS",
                name: "Fetch emails",
                description: "Fetch emails from Gmail.",
                inputParameters: { type: "object", properties: {} },
                tags: ["readOnlyHint"],
                version: "20260903_00",
                toolkit: { slug: "gmail" },
              },
            ];
          },
        },
      }),
    );

    const listed = await actions.listActions("gmail", {
      limit: WHOLE_LISTING,
    });

    // An omitted limit is not "no opinion": Composio's page defaults to 20, and
    // `getRawComposioTools` additionally sets `important=true` whenever a toolkit query carried no
    // limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so the
    // short answer is also a filtered one and nothing in it says so. Passing the limit through is
    // what turns that flag off, which is why the assertion is on the query and not on the answer.
    expect(asked).toEqual([{ toolkits: ["gmail"], limit: WHOLE_LISTING }]);
    expect(listed).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: "Fetch emails from Gmail.",
        inputParameters: { type: "object", properties: {} },
        tags: ["readOnlyHint"],
        version: "20260903_00",
      },
    ]);
  });

  test("a page of no rows is refused rather than dropped on the way to the vendor", async () => {
    const asked: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioTools: async (query: unknown) => {
            asked.push(query);
            // Twenty rows: Composio's own default page, which is what a dropped limit produces.
            return Array.from({ length: 20 }, (_, index) => ({
              slug: `GMAIL_ACTION_${index}`,
            }));
          },
        },
      }),
    );

    const refusal = await failureOf(actions.listActions("gmail", { limit: 0 }));

    /*
     * A ZERO DOES NOT TRAVEL SHORT — IT DOES NOT TRAVEL. `getRawComposioTools` composes its request
     * with `...(limit ? { limit } : {})` (`@composio/core` 0.18.1, `src/models/Tools.ts:536`) over
     * a schema that spells the field `z.number().optional()` with no floor
     * (`src/types/tool.types.ts:257`), so the request goes out with no limit and Composio answers
     * with its own page of twenty. Nothing downstream can see that: `./composio` catches a page
     * that might be a fragment by measuring it against 1000, and twenty is nowhere near it, so the
     * vendor's default commits as everything the app publishes and every action past it is deleted
     * from `mcp_tools` by a refresh that reported success.
     */
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/0 rows is not a page/);
    expect(refusal.message).toMatch(/tools already held are untouched/);
    // Nothing went out, which is the point: the fault is in the request, not in the answer.
    expect(asked).toEqual([]);
  });
});

describe("the app catalogue", () => {
  test("a toolkit becomes the row an administrator chooses from", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async (query: unknown) => {
            asked.push(query);
            return [
              {
                slug: "gmail",
                name: "Gmail",
                isLocalToolkit: false,
                meta: {
                  description: "Send and read mail.",
                  logo: "https://logos.composio.dev/gmail.png",
                  categories: [
                    { slug: "productivity", name: "Productivity" },
                    { slug: "email", name: "Email" },
                  ],
                  toolsCount: 63,
                },
              },
              // A toolkit that publishes none of the optional fields, because several do. An
              // administrator picking from a few hundred apps is better served by a missing logo
              // than by a broken one, so the absence has to survive as null rather than as "".
              {
                slug: "sparse",
                name: "Sparse",
                isLocalToolkit: false,
                meta: {},
              },
            ];
          },
        },
      }),
    );

    const apps = await broker.listApps();

    // The catalogue is asked for one page at the documented ceiling, ordered by usage so the apps
    // anybody actually connects are at the top. No search term: the SDK's list params have no such
    // field, so one passed here would be stripped before the request and the caller would be
    // filtering against a list nobody filtered.
    expect(asked).toEqual([{ limit: WHOLE_LISTING, sortBy: "usage" }]);
    expect(apps).toEqual([
      {
        slug: "gmail",
        name: "Gmail",
        description: "Send and read mail.",
        logo: "https://logos.composio.dev/gmail.png",
        categories: ["Productivity", "Email"],
        actionCount: 63,
      },
      {
        slug: "sparse",
        name: "Sparse",
        description: "",
        logo: null,
        categories: [],
        actionCount: 0,
      },
    ]);
  });
});

/**
 * The catalogue's lifetime, asserted by counting what the vendor was asked rather than what came
 * back.
 *
 * THE COST BEING AVOIDED IS NOT HYPOTHETICAL. The admin picker's search field debounces and then
 * asks `/composio/apps`, which filters the whole directory in this process because Composio's
 * toolkit listing takes no search term — so without a cache each distinct term a person types pulls
 * a few hundred rows over the wire, and pressing Add pulls them once more. Every test here therefore
 * asserts a CALL COUNT: an implementation that answered correctly and asked five times would pass
 * any assertion that only looked at the rows.
 *
 * The clock is the builder's second argument, which is why these can be written at all. Each
 * {@link buildComposioClient} holds its own cache, so a test starts from an empty one by building,
 * and moves time by assigning rather than by waiting ten minutes.
 */
describe("holding the catalogue", () => {
  /** The one row these tests map, kept out of the way of what they are actually asserting. */
  const GMAIL = {
    slug: "gmail",
    name: "Gmail",
    meta: { description: "Send and read mail.", toolsCount: 63 },
  };
  const GMAIL_ROW = {
    slug: "gmail",
    name: "Gmail",
    description: "Send and read mail.",
    logo: null,
    categories: [],
    actionCount: 63,
  };

  test("a second listing inside the window asks the vendor nothing", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async () => {
            calls += 1;
            return [GMAIL];
          },
        },
      }),
      () => clock,
    );

    const first = await broker.listApps();
    // Nine minutes is a person searching, choosing and enabling: the whole interaction this cache
    // exists for happens inside one window.
    clock += 9 * 60 * 1000;
    const second = await broker.listApps();

    expect(calls).toBe(1);
    expect(first).toEqual([GMAIL_ROW]);
    expect(second).toEqual([GMAIL_ROW]);
  });

  test("a listing after the window asks again, and answers with what it just read", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async () => {
            calls += 1;
            // The catalogue moves between the two reads, which is the only way to tell a second
            // request apart from a cache that happened to be asked twice.
            return calls === 1
              ? [GMAIL]
              : [
                  GMAIL,
                  { slug: "linear", name: "Linear", meta: { toolsCount: 12 } },
                ];
          },
        },
      }),
      () => clock,
    );

    await broker.listApps();
    clock += 10 * 60 * 1000 + 1;
    const later = await broker.listApps();

    expect(calls).toBe(2);
    expect(later).toEqual([
      GMAIL_ROW,
      {
        slug: "linear",
        name: "Linear",
        description: "",
        logo: null,
        categories: [],
        actionCount: 12,
      },
    ]);
  });

  test("callers arriving while a listing is in flight share the one request", async () => {
    let calls = 0;
    let answer: (toolkits: unknown[]) => void = () => {};
    const inFlight = new Promise<unknown[]>((resolve) => {
      answer = resolve;
    });
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: () => {
            calls += 1;
            return inFlight;
          },
        },
      }),
      () => 1_000_000,
    );

    // Not awaited between the two, because that is the case: three people opening the picker
    // together, or one debounce firing twice, all arrive before the first answer exists. A cache
    // that held the ROWS rather than the request would be empty for every one of them.
    const both = Promise.all([broker.listApps(), broker.listApps()]);
    answer([GMAIL]);
    const [first, second] = await both;

    expect(calls).toBe(1);
    expect(first).toEqual([GMAIL_ROW]);
    expect(second).toEqual([GMAIL_ROW]);
  });

  test("a refusal is not held, so the next caller asks the vendor again", async () => {
    let calls = 0;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async () => {
            calls += 1;
            // The real first failure here is a key that is unset or wrong, and the operator who
            // fixes it presses the button again within seconds. A cached refusal would keep
            // refusing for ten minutes with nothing left to fix.
            if (calls === 1) throw new Error("Composio refused the catalogue.");
            return [GMAIL];
          },
        },
      }),
      () => 1_000_000,
    );

    await expect(broker.listApps()).rejects.toThrow(/refused/);
    // The clock has not moved: the window is still open and it is the FAILURE rather than the
    // window that must not be remembered.
    const recovered = await broker.listApps();

    expect(calls).toBe(2);
    expect(recovered).toEqual([GMAIL_ROW]);
  });
});

describe("executing an action", () => {
  test("an action belonging to another app is refused before anything is sent", async () => {
    const executed: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            toolkit: { slug: "gmail" },
          }),
          execute: async (...call: unknown[]) => {
            executed.push(call);
            return { data: {}, error: null, successful: true };
          },
        },
      }),
    );

    // The gate in `./access` cleared this person for slack, because slack is what the connection's
    // url names. The slug was recorded by some earlier listing, and Composio's execute takes the
    // slug ALONE — there is no toolkit field on the wire — so forwarding this would run a Gmail
    // action under a gate that only ever looked at a Slack connection.
    const refused = actions.execute(
      {
        toolkit: "slack",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_1",
        version: "20260903_00",
      },
      { max_results: 5 },
    );

    // Both apps are named, because a reader holding only one of them cannot tell whether the url
    // is wrong or the recorded action is.
    const refusal = await failureOf(refused);
    expect(refusal.message).toMatch(/slack/);
    expect(refusal.message).toMatch(/gmail/);
    // AND THE STEP, because a sentence that names both apps and stops there leaves the reader
    // holding a contradiction with nothing to do about it. The url this action was recorded under
    // has changed, and refreshing the app's tools is what reconciles the two.
    expect(refusal.message).toMatch(
      /Refreshing this app's tools on its Plugins page/,
    );
    expect(executed).toEqual([]);
  });

  /**
   * WHOSE CALL IT IS, WHICH NOTHING IN THIS FILE WAS ASKING.
   *
   * Every test around this one is about a call being REFUSED, and each asserts that nothing went
   * out. Not one asserted what goes out when the call is allowed — so the three fields that decide
   * what a successful call MEANS were covered by nobody. `userId` is the whole of a tool call's
   * attribution to a person: it is what Composio resolves to a connected account, so replacing it
   * with a literal runs one person's action against somebody else's mailbox, and the audit row this
   * deployment writes afterwards names the wrong human. `version` is what stops a recorded action
   * being run at whatever Composio publishes today. `arguments` is the call itself.
   *
   * ASSERTED AS THE WHOLE CALL RATHER THAN FIELD BY FIELD, because an extra field on this request is
   * as much a finding as a missing one — `allowMultiple`, a session id, a modifier — and a per-field
   * assertion is blind to every one of them.
   *
   * THE RESOLVE IS ASSERTED TOO, for the reason the execute is. It is the round trip this adapter
   * spends on purpose, and the version it carries is what decides WHICH definition of the action the
   * app-mismatch check below is made against.
   */
  test("a call that runs carries the person, the version and the arguments", async () => {
    const resolved: unknown[] = [];
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async (...call: unknown[]) => {
            resolved.push(call);
            return {
              slug: "GMAIL_FETCH_EMAILS",
              name: "Fetch emails",
              toolkit: { slug: "gmail" },
            };
          },
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { data: { messages: [] }, error: null, successful: true };
          },
        },
      }),
    );

    const answer = await actions.execute(
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        // DELIBERATELY NOT THE `user_1` EVERY OTHER FIXTURE HERE USES. A literal standing in for
        // the caller's id is the mutation this test exists to catch, and the file's own house id is
        // the one literal a mutation would plausibly be — so a person named after nothing else is
        // what makes the assertion able to tell attribution from coincidence.
        userId: "user_whose_mailbox_this_is",
        version: "20260903_00",
      },
      { max_results: 5 },
    );

    expect(resolved).toEqual([
      ["GMAIL_FETCH_EMAILS", { version: "20260903_00" }],
    ]);
    expect(ran).toEqual([
      [
        "GMAIL_FETCH_EMAILS",
        {
          arguments: { max_results: 5 },
          userId: "user_whose_mailbox_this_is",
          version: "20260903_00",
        },
      ],
    ]);
    // And the vendor's answer crosses the seam as itself: this adapter adds nothing to a result and
    // takes nothing off one.
    expect(answer).toEqual({
      data: { messages: [] },
      error: null,
      successful: true,
    });
  });
});

/**
 * Minting one person's connect link, which is the call that decides whether consent comes back.
 *
 * `connectedAccounts.link` RATHER THAN `toolkits.authorize`, and the difference is the whole
 * subject of these two tests. `toolkits.authorize` takes a user id, a toolkit and an optional auth
 * config id and has nowhere to put a callback, so every consent it started ended on Composio's own
 * hosted page: the person had granted access and the only way back to this deployment was to find
 * it again by hand. `link` carries the callback, and it is also the vendor's own named replacement
 * for `initiate` on Composio-managed OAuth, which is exactly what `ensureAuthConfig` creates here.
 *
 * The auth config is READ rather than created, because this deployment already made it when an
 * administrator enabled the app — named for this deployment, visible in an operator's dashboard.
 * `toolkits.authorize` would have created one on demand at Composio's defaults, which is the
 * behaviour enabling-time creation exists to replace.
 */
describe("beginning one person's connection", () => {
  test("the link carries the page this deployment sends them back to", async () => {
    const linked: unknown[] = [];
    const listed: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) => {
            listed.push(query);
            return {
              items: [
                {
                  id: "ac_this_deployments",
                  name: "Linear (OpenBot)",
                  status: "ENABLED",
                },
              ],
            };
          },
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const begun = await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl:
        "https://openbot.test/settings/connected-accounts/composio-linear",
    });

    // The config this deployment already holds for the app — and no `authConfigs.create`, which
    // would refuse in `fakeVendor` if it were reached. The listing asks for disabled configs too,
    // because a config it cannot see is one `ensureAuthConfig` would create a second of.
    expect(listed).toEqual([
      { toolkit: "linear", limit: WHOLE_LISTING, showDisabled: true },
    ]);
    expect(linked).toEqual([
      [
        "user_1",
        "ac_this_deployments",
        {
          callbackUrl:
            "https://openbot.test/settings/connected-accounts/composio-linear",
        },
      ],
    ]);
    expect(begun).toEqual({
      redirectUrl: "https://backend.composio.dev/s/a-link",
    });
  });

  test("an app with no auth config is a refusal naming an administrator's step", async () => {
    /*
     * The state is real rather than defensive: an app enabled before this deployment created
     * configs at all, or a config deleted by hand in Composio's dashboard. Creating one here
     * instead would mint it unnamed, at the vendor's managed defaults, at the moment somebody
     * pressed Connect — and nothing would be minted for the person to visit either way, so the
     * honest answer names the app and the step that fixes it.
     */
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [] }) },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl:
        "https://openbot.test/settings/connected-accounts/composio-linear",
    });

    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/linear/);
    // THE REMEDY AND NOT THE APP'S NAME. All three of this method's refusals name the app, so
    // `/linear/` passes whichever branch was taken and the branch under test could be deleted
    // outright without reddening anything. What distinguishes this state is what fixes it.
    expect(refusal.message).toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    expect(refusal.message).not.toMatch(NO_PAGE_REMEDY);
    // And nothing was begun at the vendor: a link against a config chosen by nobody would attach
    // this person's account to a configuration this deployment cannot see or tighten.
    expect(linked).toEqual([]);
  });
});

/**
 * Choosing WHICH auth config, which is a question this file used to answer with "the first one".
 *
 * An auth config lives in the project the API key belongs to, beside any an operator built by hand
 * in Composio's own dashboard, and the vendor's listing has no documented order. So "the first row"
 * is a coin toss between an object this deployment created and an object it knows nothing about —
 * and the two callers tossed it separately, so they could land on different rows. The name is the
 * only provenance Composio offers: {@link CONFIG_SUFFIX} is written into it at creation for exactly
 * this, and was then read by nobody.
 */
describe("telling this deployment's auth configs from anybody else's", () => {
  /**
   * What a listing of one app's configs looks like when an operator has been in the dashboard.
   *
   * SPELLED OUT OF THE ORDER THE ASSERTIONS EXPECT, which is what makes the sort the thing under
   * test rather than scenery. Composio documents no order for this listing; `configsMadeHere`
   * filters to ours and then sorts on the id, and every fixture this file used to hold was already
   * id-ordered — so the sort could be replaced with a plain copy and all 24 tests stayed green.
   * Here the spare arrives FIRST and sorts SECOND, so a filter alone answers `ac_ours_spare` where
   * every assertion below names `ac_ours`, and the delete's order is the sort's rather than the
   * vendor's.
   */
  const MIXED = [OURS_SPARE, BY_HAND, OURS];

  test("a connection is begun against the config this deployment made, not the first row", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: MIXED }) },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    // A connection is a lasting attachment to whatever config it was made against: scopes, tool
    // restrictions and a lifetime this deployment neither chose nor can read. Attaching somebody to
    // the hand-made one is not a mistake a later call can correct.
    expect(linked).toEqual([
      [
        "user_1",
        "ac_ours",
        { callbackUrl: "https://openbot.test/settings/connected-accounts/x" },
      ],
    ]);
  });

  test("an app whose only config was made by hand is refused rather than borrowed", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [BY_HAND] }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    // The same state as an app with no configs at all — none of OURS — so the same remedy, and
    // not the disabled one: the config that exists here is enabled, and enabling it again is
    // advice that would send an operator to a dashboard to change nothing.
    expect(refusal.message).toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    expect(linked).toEqual([]);
  });

  test("removing an app drops every config of ours and leaves the hand-made one standing", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // Both of ours go — leaving one behind would leave live grants — and the hand-made
          // one stands. The listing arrives spare-first, so the order asserted below is the sort's
          // and not the vendor's.
          list: async () => ({ items: MIXED }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // `revoke_on_delete` on each, because the endpoint soft-deletes and revokes nothing without it
    // — and this is the one call that reaches an account whose local row drifted away.
    expect(deleted).toEqual([
      ["ac_ours", { revoke_on_delete: true }],
      ["ac_ours_spare", { revoke_on_delete: true }],
    ]);
  });

  test("a config left standing is a failure, and the count is the message", async () => {
    /*
     * THE TWIN OF THE PARTIAL REVOKE, WHICH HAD TWO TESTS WHILE THIS HAD NONE — so this throw
     * could be deleted with the whole suite green. The caller is `removeServer`, which deletes the
     * app's row once this returns: a config left standing is a live grant that the removal was
     * supposed to end, and nothing in this deployment can find it again afterwards.
     *
     * The count is asserted rather than the fact of a refusal, because the count is the whole
     * remedy: an operator who reads that one of two went knows that pressing remove again finishes
     * the job rather than repeats it.
     */
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: MIXED }),
          delete: async (id: string) => {
            if (id === "ac_ours_spare") {
              throw new Error("Composio refused that one.");
            }
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /removed 1 of this deployment's 2 authorization configs for linear/,
    );
  });

  test("an app whose configs no longer carry this deployment's name is not a clean removal", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          /*
           * THE CONFIG THIS DEPLOYMENT MADE, RENAMED IN COMPOSIO'S DASHBOARD. Same object, same
           * grants on it, same accounts connected against it; the one field that changed is the
           * only one this file writes and the only one it can recognise itself by.
           */
          list: async () => ({
            items: [{ id: "ac_ours", name: "Linear", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * QUIET IS THE FAILURE HERE, AND IT IS THE ONE NOTHING REPORTS. `deleteAuthConfig` returning
     * normally lets `removeServer` delete the app's row, which is the last thing in this
     * deployment naming the app — so an administrator reads that the app was withdrawn while the
     * config and every grant made against it stand at Composio with nothing pointing at them.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal).not.toBeInstanceOf(AggregateError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The count of what is standing and the marker that would claim it, which together are the
    // whole remedy: an operator can look at one config and see which of the two readings it is.
    expect(refusal.message).toMatch(/Composio holds 1 for linear/);
    expect(refusal.message).toMatch(/\(OpenBot\)/);
    /*
     * AND NOTHING WAS DELETED, which is the half this refusal is not allowed to trade away. The
     * row carries no marker, so deleting it is as likely to destroy an operator's own dashboard
     * work — with every account on THAT — as it is to finish the removal.
     */
    expect(deleted).toEqual([]);
  });

  /**
   * A CONFIG ROW THE LISTING NAMED TWICE IS ONE CONFIG, NOT TWO — the twin of the account dedupe
   * that landed a wave earlier, one function away, and was not brought here.
   *
   * The paging loop guards against the vendor repeating a CURSOR and not against it repeating a
   * ROW: a page boundary crossed while a config is created, or a proxy stitching two overlapping
   * pages together, hands one id over twice with the cursor advancing perfectly each time. The
   * second delete of that config then meets Composio's "there is no such auth config", which
   * arrives as a refusal — so a removal that had in fact COMPLETED was counted as partial,
   * `removeServer` never deleted the app's row, and every retry met the same duplicate and failed
   * in the same place. An app in that state can never be removed.
   *
   * THE DOUBLE REFUSES THE SECOND DELETE OF ONE CONFIG, which is what the vendor does and what
   * makes this test able to fail. A stub that answered both identically would be green against an
   * adapter that sent the delete twice.
   */
  test("a config the listing named twice is removed once", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [OURS], nextCursor: "page_2" }
              : { items: [OURS], nextCursor: null },
          delete: async (id: string) => {
            if (deleted.includes(id)) {
              throw new Error(
                `Composio holds no auth config with the id ${id}.`,
              );
            }
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
  });

  /**
   * AND THE COUNT IN A REAL PARTIAL REMOVAL IS OF CONFIGS, NOT OF ROWS — the same pairing the
   * account dedupe has, for the same reason: an inflated denominator is a figure nothing measured,
   * in the one sentence an operator is meant to act on.
   */
  test("a duplicated row is not a third config in the sentence a partial removal carries", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [OURS, OURS, OURS_SPARE] }),
          delete: async (id: string) => {
            if (id === "ac_ours_spare") {
              throw new Error("Composio refused that one.");
            }
          },
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /removed 1 of this deployment's 2 authorization configs for linear/,
    );
  });

  /**
   * A ROW THAT COULD NOT BE READ MUST NOT BLOCK THE CONNECTION IT HAS NOTHING TO DO WITH.
   *
   * Reading the configs used to throw on the first row it could not check, so one unreadable row
   * refused every call that reads this listing — including this one, where a config of ours was
   * read, is ENABLED, and is the right thing to attach somebody to whatever else the listing held.
   * The person is told the vendor's shape is wrong about an app they can perfectly well connect.
   */
  test("an unreadable row does not stop a connection against the config that was readable", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_nameless", status: "ENABLED" }, OURS],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    expect(linked).toEqual([
      ["user_1", "ac_ours", { callbackUrl: RETURN_URL }],
    ]);
  });

  /**
   * AND WHERE THERE IS NOTHING OF OURS TO GO ON, THE REMEDY IS NOT THE ONE FOR AN APP WITH NO
   * CONFIG. "Remove the app and add it again" is a loop that cannot close in this state: the
   * removal meets its own refusal over the same unreadable row, and so does the enable. The
   * sentences are told apart by their remedies here for the reason {@link NO_CONFIG_REMEDY} exists.
   */
  test("a listing this deployment cannot read is not an app with no config", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [{ id: "ac_nameless" }] }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
    expect(refusal.message).not.toMatch(DISABLED_REMEDY);
    // And nobody was sent anywhere: a link is a lasting attachment to one config, so it is never
    // minted off a listing this deployment could not read.
    expect(linked).toEqual([]);
  });

  /**
   * AND NOTHING IS CREATED BESIDE A ROW THAT MIGHT ALREADY BE OURS, which is the one caller of the
   * four that must refuse rather than act on what it can name. A second config is not a duplicate
   * but a SPLIT: two populations of connections for one app, and a removal later that drops half.
   */
  test("a row this deployment cannot read stops a second config being created", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [{ id: "ac_nameless" }] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(created).toEqual([]);
  });

  test("an app Composio holds no configs for at all is still a quiet removal", async () => {
    /*
     * THE HALF THE REFUSAL ABOVE MUST NOT SWALLOW. Removing an app has to be able to happen twice:
     * an app can be removed, re-enabled and removed again, two administrators can press the button
     * together, and an app enabled before this deployment created configs at all has none to drop.
     * In each of those the end state is the one that was asked for, so a throw would report a
     * failure to somebody who got exactly what they wanted — and an implementation that reached
     * green above by refusing whenever it deleted nothing would do precisely that.
     *
     * AND IT SAYS SO RATHER THAN LEAVING IT TO BE INFERRED, which it did not: this test held no
     * assertion at all. What it actually pinned was "the call did not throw", which a reader has to
     * reconstruct from the absence of an `expect` — and the other half, that nothing was deleted,
     * rested on {@link fakeVendor}'s stub refusing, where a call that WAS made and a call that was
     * not both end the test the same way round. Both halves are stated here.
     */
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await expect(broker.deleteAuthConfig("linear")).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });

  test("a disabled config of ours stops a second one being created", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // Disabled configs are asked for, because this listing is what decides whether to create.
          // A listing that omitted them would find nothing and create the split it exists to stop.
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "DISABLED" },
            ],
          }),
          create: async (...call: unknown[]) => {
            created.push(call);
          },
        },
      }),
    );

    await broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" });

    expect(created).toEqual([]);
  });

  test("a disabled config is a refusal rather than a link that cannot work", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "DISABLED" },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    const refused = broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    });

    // Sending somebody to consent against a disabled config spends their consent and attaches
    // nothing, and nothing on the page they are on can fix it. The act that DOES fix it is an
    // operator's in Composio's own dashboard, which is the one thing the no-config sentence next
    // door never says — so that is what this asserts.
    const refusal = await failureOf(refused);
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(DISABLED_REMEDY);
    expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
    expect(linked).toEqual([]);
  });

  test("an app with only somebody else's config still gets one of our own", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [BY_HAND] }),
          create: async (...call: unknown[]) => {
            created.push(call);
            return CREATED;
          },
        },
      }),
    );

    await broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" });

    // Adopting the hand-made one would have this deployment mint connections against scopes it
    // cannot see and delete an operator's work when the app is removed.
    expect(created).toEqual([
      [
        "linear",
        { type: "use_composio_managed_auth", name: "Linear (OpenBot)" },
      ],
    ]);
  });
});

/**
 * Ending somebody's access, which is the claim this whole surface is here to be able to make.
 *
 * THE DELETE DOES NOT REVOKE, and that is the vendor's own description of it: it "soft-deletes a
 * connected account by marking it as deleted in the database", preserving the record, unless
 * `revoke_on_delete` is passed. Every path that says it ended somebody's access — a person
 * disconnecting, an app being removed, a person being offboarded — runs through this method and
 * wrote `true` into the audit trail while the refresh token at Google was untouched. The assertions
 * here are therefore on WHAT WENT OUT rather than on what came back: an implementation that dropped
 * the flag answers every one of them identically.
 */
describe("withdrawing one person's grants", () => {
  test("the delete asks for the upstream credentials to be revoked", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual([["ca_1", { revoke_on_delete: true }]]);
  });

  test("a delete Composio answered `success: false` is not a withdrawal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          // A 200 whose body says the account was not deleted. The flag went out, Composio read
          // the request and answered it — this is the vendor declining, not failing.
          delete: async () => ({ success: false }),
        },
      }),
    );

    /*
     * WITHOUT THE CHECK THIS ANSWERS `true`, WHICH IS THE WHOLE FINDING. `store.ts` writes that
     * boolean into `mcp.account_disconnected` as `vendorRevocationRequested` and then deletes the
     * `composio_connections` row — the only thing in this deployment naming which app this person
     * connected. So a `success: false` nobody read ends as a trail entry claiming a grant was
     * withdrawn, an account that is still live at Google, and nothing left pointing at it.
     *
     * ASSERTED AS A REFUSAL AND AS A COUNT, because "did not answer true" is satisfied by a crash.
     */
    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(
      /withdrew 0 of this person's 1 accounts for gmail/,
    );
    expect(refusal.message).not.toMatch(A_CRASH);
    // The reason lives on `cause`, because the count is deliberately the whole of the sentence.
    expect(everythingSaidBy(refusal).join(" ")).toMatch(/success: false/);
  });

  test("a delete whose verdict Composio did not send is not counted as one either", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          /*
           * `success` IS REQUIRED IN THE DECLARATION AND ABSENT ON THIS WIRE, which is the shape
           * the check has to survive rather than the one it is for. `@composio/client` parses the
           * body and hands it over, so the schema's "required" is a promise about what Composio
           * means to send and not a fact about what arrived.
           */
          delete: async () => ({}),
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);

    /*
     * A DIFFERENT SENTENCE FROM THE ONE NEXT DOOR, and that is what this asserts. "Composio said
     * no" is a fact about this account that a second press can meet again; "Composio answered
     * something this deployment cannot read" is a fact about the package, correctable by nobody
     * holding an admin page. Collapsing them would send an operator to press a button for a
     * condition a button cannot change.
     */
    const said = everythingSaidBy(refusal).join(" ");
    expect(said).toMatch(/upgrading this deployment's @composio\/core/);
    expect(said).not.toMatch(/success: false/);
  });

  test("the listing asks about every state a grant can be hiding in", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return { items: [] };
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      false,
    );

    /*
     * `accountType` because its default is private accounts only, so a shared account is invisible
     * to a listing that omits it — and an invisible account is a live grant this answers `false`
     * about. The statuses because an unfinished consent or a lapsed token is still something a
     * provider is holding. `REVOKED` is the one left out: it is the only status that says the grant
     * is already gone, and deleting a tombstone would have this report a withdrawal that never was.
     *
     * AND `authConfigIds`, WHICH THIS ASSERTION USED TO SAY WAS ABSENT. It was written out as the
     * whole query on the reasoning that the breadth is the point — and it is, for three of the four
     * parameters. The fourth is the opposite: omitting it asks about every authorization config in
     * the project, including ones an operator built by hand in Composio's dashboard, and this
     * listing is the one that decides what gets deleted with `revoke_on_delete`. The assertion was
     * therefore pinning the defect in place, which is why it moved rather than being relaxed.
     */
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: [
          "INITIALIZING",
          "INITIATED",
          "ACTIVE",
          "FAILED",
          "EXPIRED",
          "INACTIVE",
        ],
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
      },
    ]);
  });

  test("being connected is a narrower question, and asked as one", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return { items: [{ id: "ca_1" }] };
          },
        },
      }),
    );

    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);

    // ACTIVE only — an unfinished or expired account must not tell somebody their app is wired up —
    // but `accountType: "ALL"` all the same, because a shared account is a connected account.
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: ["ACTIVE"],
        accountType: "ALL",
        limit: WHOLE_LISTING,
      },
    ]);
  });

  test("nobody with no account for the app is answered no", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: { list: async () => ({ items: [] }) },
      }),
      () => 1_000_000,
    );

    /*
     * THE ONLY TEST IN THIS FILE THAT CAN FAIL A GATE THAT ALWAYS OPENS. Both assertions about
     * `isConnected` expected `true`, so `async isConnected() { return true }` was green — and a
     * gate that cannot answer no is a gate that lets every call through, which is exactly the
     * question `./access` asks this method before running somebody's action.
     */
    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(false);
  });

  test("a refusal partway through still asks about the accounts behind it", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refused = broker.revoke({ userId: "user_1", toolkit: "gmail" });

    // The third account is the whole point: a throw at the second used to abandon it, so a grant
    // nobody ever asked about outlived a call that reported only the failure of a different one.
    await expect(refused).rejects.toThrow(/2 of this person's 3 accounts/);
    expect(deleted).toEqual(["ca_1", "ca_3"]);
  });

  test("a partial withdrawal is a failure rather than a reported disconnection", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            return WITHDRAWN;
          },
        },
      }),
    );

    /*
     * NOT A `true`. `store.ts` revokes and only then deletes the `composio_connections` row, which
     * is the only thing naming which app this person connected; a `true` here deletes that row, the
     * trail records a disconnection, and the account this call could not end is left live with
     * nothing pointing at it. The throw leaves the row standing, so pressing disconnect again is a
     * second attempt with everything the first one had.
     */
    await expect(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    ).rejects.toBeInstanceOf(BrokerRefusalError);
  });

  /**
   * AN ACCOUNT THIS DEPLOYMENT CANNOT NAME MUST NOT STOP IT WITHDRAWING THE ONES IT CAN.
   *
   * The id check used to run over every row BEFORE any delete went out, so one row whose id
   * Composio omitted threw ahead of the first withdrawal — and the next attempt met the same row
   * and threw in the same place. A person with three grants and one unreadable row could never
   * withdraw any of them, for ever, and the page told them to try again.
   *
   * THE TWO FAILURES THIS SITS BETWEEN ARE BOTH WORSE, which is why the answer is neither of them. A
   * delete sent with `undefined` where an id belongs is a request Composio may read as anything,
   * followed by a `true` and an audit row saying this person's access ended. Refusing before
   * anything goes out is a permanent block over a row nobody can remove from here. What a person is
   * owed is the withdrawal of every grant this deployment CAN name, and a sentence counting what
   * was left — which is a state they can act on, by removing the rest in Composio's own dashboard.
   */
  test("an account with no id does not stop the accounts beside it being withdrawn", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: null }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Both readable grants gone, and no delete sent for the row that had no id: a withdrawal of
    // `undefined` is the request this whole guard exists to stop being made.
    expect(deleted).toEqual(["ca_1", "ca_3"]);
    // STILL A FAILURE, because `store.ts` deletes the `composio_connections` row on a `true` and
    // that row is the only thing in this deployment naming which app this person connected.
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).toMatch(/2 of this person's 3 accounts/);
    // And the reason the third could not be asked about is named, because "try again" is not the
    // remedy for it and the reader would otherwise be given a count with no way to read it.
    expect(failure.message).not.toMatch(A_CRASH);
    expect((failure.cause as Error).message).toMatch(/id/);
  });

  /**
   * AND A CONFIG ROW THIS DEPLOYMENT CANNOT READ MUST NOT STOP IT EITHER — the same correction as
   * the account above, one listing earlier, where it was still live after that one landed.
   *
   * Reading the configs threw on the first row it could not check, and the withdrawal reads them
   * BEFORE it reads a single account. So one unreadable config row meant a person could never
   * withdraw anything for that app: every press met the same row and the same throw, ahead of the
   * first delete, with their readable grants standing the whole time. What they are owed is the
   * withdrawal of every grant this deployment can reach and a sentence about what it could not.
   */
  test("a config row that could not be read does not stop the grants behind the one that could", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_gmail_nameless" }, OUR_GMAIL],
          }),
        },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The grant on the config that WAS readable is gone, which is the half a throw ahead of the
    // loop threw away.
    expect(deleted).toEqual(["ca_1"]);
    // And still a failure, because a grant of theirs may sit on the config that could not be read
    // and nothing here ever asked about it — so `store.ts` must not delete the row that names this
    // person's connection.
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
    expect(failure.message).toMatch(/withdrew 1 of this person's 1 accounts/);
    expect(failure.message).toMatch(/authorization configs for gmail/);
    // And the reason that row could not be sorted travels as `cause`, because the sentence above is
    // deliberately a count and leaves the reasons nowhere else to live.
    expect((failure.cause as Error).message).toMatch(/name/);
  });

  /**
   * THE GATE IS A COUNT AND WAS ASKING FOR AN ID IT NEVER USES.
   *
   * `isConnected` answers whether this person holds an ACTIVE account for an app, which is a
   * question about how many rows came back — the id is the revoke's business and nothing this
   * question reads. Taking the ids anyway meant an account Composio described without one turned a
   * true answer into a thrown refusal: the person IS connected, and the gate that refuses their run
   * says so on the strength of a field it was never going to look at.
   */
  test("an account the vendor described without an id still counts as connected", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: { list: async () => ({ items: [{}] }) },
      }),
      () => 1_000_000,
    );

    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);
  });

  /**
   * AN OPERATOR'S OWN AUTHORIZATION CONFIG IS NOT THIS DEPLOYMENT'S TO EMPTY.
   *
   * The account listing was asked by person, by app and by "all account types" and by nothing else,
   * so it returned every account Composio holds for that pair — including ones attached to a config
   * an operator built by hand in their dashboard, for purposes this deployment knows nothing about,
   * and including the SHARED ones other people are acting through. Each of those was then deleted
   * with `revoke_on_delete`, which tears the grant up at the provider. One person pressing
   * disconnect on their own settings page ended somebody else's integration, silently, and answered
   * `true`.
   *
   * WHICH IS THE PRINCIPLE `deleteAuthConfig` ALREADY STATES ONE LEVEL UP: it refuses to delete a
   * config it cannot show is this deployment's, on exactly the reasoning that an operator's
   * dashboard work is not ours to destroy. The accounts hanging off that config are the same work.
   *
   * ASSERTED ON WHAT WENT OUT, because an implementation that asked the unscoped question and then
   * deleted everything it found answers this test's `true` just as confidently.
   */
  test("the withdrawal asks only about accounts on configs this deployment made", async () => {
    const scoped: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          // An operator's beside ours, which is the state the whole guard is about. Out of the
          // vendor's order, so a reader that took the first row would take the wrong one.
          list: async () => ({ items: [BY_HAND_GMAIL, OUR_GMAIL] }),
        },
        connectedAccounts: {
          list: async (query: unknown) => {
            scoped.push((query as { authConfigIds?: unknown }).authConfigIds);
            return { items: [{ id: "ca_1" }] };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );

    // The operator's config is not in the question, so no account on it can be in the answer and
    // none of them can reach the delete.
    expect(scoped).toEqual([[OUR_GMAIL.id]]);
    expect(deleted).toEqual(["ca_1"]);
  });

  /**
   * NOTHING AT ALL IS NOTHING TO WITHDRAW, AND IT IS ANSWERED WITHOUT ASKING.
   *
   * `authorize` mints every connect link against a config this deployment made and refuses where
   * there is none, so an app Composio holds no configs for never had a connection begun through it.
   * Listing accounts anyway could only turn up somebody else's, and the one thing this call does
   * with an account it turns up is delete it.
   *
   * THE ASSERTION IS THE DOUBLE. `connectedAccounts.list` is left at {@link fakeVendor}'s refusal,
   * so an implementation that asked the question at all fails here by name — which is a stronger
   * statement than the `false` beside it, because a listing scoped to an EMPTY set of configs would
   * answer `false` too while putting a filter on the wire that the far side is free to read as no
   * filter at all.
   */
  test("a person's accounts are not listed where Composio holds no config for the app", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ authConfigs: { list: async () => ({ items: [] }) } }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      false,
    );
  });

  /**
   * AND "NONE OF OURS" IS NOT THAT STATE — THE SEVENTH ROUTE TO A REVOCATION THAT DID NOT REVOKE.
   *
   * THIS TEST ASSERTED THE `false`, AND THE `false` WAS THE DEFECT. It stood on the reasoning above
   * — none of ours means nothing was ever granted through this app — which is sound about an app
   * Composio holds no configs for and cannot tell that app from this one. An operator renames a
   * config in Composio's dashboard, dropping the suffix or editing the app's title past it, and
   * this deployment's own live grants read as somebody else's work: `store.ts` then writes
   * `vendorRevocationRequested: false` into the audit trail and deletes the `composio_connections`
   * row, so the person's grant stands at the provider with nothing naming it and the trail records
   * that no withdrawal was even asked for. The assertion is changed on purpose, and the case it
   * used to cover — Composio holding nothing at all — is asserted next door, where it is true.
   *
   * `deleteAuthConfig` HAS REFUSED IN EXACTLY THIS STATE SINCE THE WAVE BEFORE THIS ONE, which is
   * what makes this a disagreement rather than a judgement call: two halves of removing an app's
   * access read one condition two different ways, one function apart.
   *
   * THE DOUBLE IS STILL THE OTHER HALF OF THE ASSERTION. `connectedAccounts.list` is left refusing,
   * so an implementation that answered this by listing somebody else's accounts — and then deleting
   * what it found — fails here by name.
   */
  test("an app whose configs no longer carry this deployment's name is not a quiet disconnection", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [BY_HAND_GMAIL] }) },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    // The count standing and the marker that would have claimed it, which is the same pair
    // `deleteAuthConfig` hands an operator for the same state and the same one act in a dashboard.
    expect(refusal.message).toMatch(/Composio holds 1 for gmail/);
    expect(refusal.message).toMatch(/\(OpenBot\)/);
  });

  /**
   * A WITHDRAWAL THAT HAPPENED, REPORTED AS A FAILURE — the guard for `success: false` overreaching.
   *
   * The installed client resolves two answers with no document at all: a 204 becomes `null`
   * ("fetch refuses to read the body when the status code is 204") and a JSON reply carrying
   * `content-length: 0` becomes `undefined` (`@composio/client` 0.1.0-alpha.76,
   * `src/internal/parse.ts:16-42`). Neither can be a rejection the vendor made: every `!response.ok`
   * is thrown as an `APIError` before parsing (`src/client.ts:539`), so an answer arriving at all is
   * Composio having accepted the request and deleted the account.
   *
   * READING THAT AS "NO VERDICT" TURNED A COMPLETED WITHDRAWAL INTO A PARTIAL-WITHDRAWAL REFUSAL,
   * which leaves the person's connection row standing, tells them their access has not ended, and
   * has them press disconnect again — against an account that is already gone, which is a second
   * fault waiting on the first. It is the same lie as the unread `success: false` before it, facing
   * the other way.
   *
   * THE OTHER DIRECTION IS ASSERTED NEXT DOOR AND IS NOT WEAKENED BY THIS: `{}` is a document that
   * arrived without its verdict, which is a fact about the package, and it still refuses.
   */
  for (const { shape, answer } of [
    { shape: "a 204 carrying no content", answer: null },
    { shape: "a JSON reply of content-length zero", answer: undefined },
  ]) {
    test(`a withdrawal Composio answered with ${shape} is a withdrawal`, async () => {
      const deleted: string[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: { list: ourGmailConfig },
          connectedAccounts: {
            list: async () => ({ items: [{ id: "ca_1" }] }),
            delete: async (id: string) => {
              deleted.push(id);
              return answer;
            },
          },
        }),
      );

      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      // And the flag still went out, so the `true` is about a delete that asked for the grant to be
      // revoked rather than about one that quietly filed the account away.
      expect(deleted).toEqual(["ca_1"]);
    });
  }

  /**
   * A ROW THE LISTING NAMED TWICE IS ONE ACCOUNT, NOT TWO.
   *
   * The paging loop guards against the vendor repeating a CURSOR and not against it repeating a
   * ROW, and those are different faults: a page boundary crossed while accounts are being created
   * or deleted, or a proxy stitching two overlapping pages together, hands the same id over twice
   * with a cursor that advanced perfectly each time. The second delete then meets Composio's "there
   * is no such account" — which arrives as a refusal — so a withdrawal that in fact COMPLETED was
   * thrown over as a partial one, the person's connection row was left standing, and every retry
   * met the same duplicate and failed in the same place.
   *
   * THE DOUBLE REFUSES THE SECOND DELETE OF ONE ACCOUNT, which is what the vendor does and what
   * makes this test able to fail. A stub that answered both identically would be green against an
   * adapter that sent the delete twice.
   */
  test("an account the listing named twice is withdrawn once", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [{ id: "ca_1" }], nextCursor: "page_2" }
              : { items: [{ id: "ca_1" }], nextCursor: null },
          delete: async (id: string) => {
            if (deleted.includes(id)) {
              throw new Error(
                `Composio holds no connected account with the id ${id}.`,
              );
            }
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual(["ca_1"]);
  });

  /**
   * AND THE COUNT IN A REAL PARTIAL FAILURE IS OF ACCOUNTS, NOT OF ROWS.
   *
   * The denominator was `accounts.length`, which is how many rows the listing handed over — so a
   * listing that named one account twice made the sentence a reader is meant to act on state a
   * figure nothing had counted. "One of three" over two accounts is the same class of mistake as
   * the page-ceiling sentence that asserted a row count it had not measured.
   */
  test("a duplicated row is not a third account in the sentence a partial failure carries", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_1" }, { id: "ca_2" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused this one.");
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).toMatch(/withdrew 1 of this person's 2 accounts/);
    expect(failure.message).not.toMatch(A_CRASH);
  });
});

/**
 * The three refusals this file authors, and the one thing a route has to be able to do with them.
 *
 * `routes.ts` answers a thrown broker error by reaching into it for the vendor's own sentence and,
 * finding none, telling the reader that Composio said nothing about why and that an administrator
 * should check this deployment's key. That advice is wrong for every sentence below: Composio
 * answered, this deployment decided, and the remedy is already written down. `brokerSentence` is the
 * one seam that tells the two apart, so these assert the recognition rather than the wording.
 */
describe("refusals a route can tell from an outage", () => {
  test("an app with no config of ours is recognised as this deployment's own refusal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({ authConfigs: { list: async () => ({ items: [] }) } }),
    );

    const error = await broker
      .authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: "https://openbot.test/settings/connected-accounts/x",
      })
      .catch((raised: unknown) => raised);

    // `/An administrator/` opens two of this method's three refusals, so it recognised the class
    // and not the branch. The remedy is what a reader is being handed.
    expect(brokerSentence(error)).toMatch(NO_CONFIG_REMEDY);
    expect(brokerSentence(error)).not.toMatch(DISABLED_REMEDY);
  });

  test("a consent with nowhere to send anybody is recognised too", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_ours", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
        },
        // An API-key toolkit is connected by typing a secret rather than by visiting a page, so the
        // vendor answers with no url. Nothing is wrong with the key, and saying so would be a
        // second wrong answer on top of a first.
        connectedAccounts: { link: async () => ({ redirectUrl: null }) },
      }),
    );

    const error = await broker
      .authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: "https://openbot.test/settings/connected-accounts/x",
      })
      .catch((raised: unknown) => raised);

    expect(brokerSentence(error)).toMatch(NO_PAGE_REMEDY);
    expect(brokerSentence(error)).not.toMatch(NO_CONFIG_REMEDY);
    expect(brokerSentence(error)).not.toMatch(DISABLED_REMEDY);
  });
});

/**
 * What the catalogue is allowed to be, given that it is cached and then believed.
 */
describe("a catalogue that might be a fragment", () => {
  test("a full page is refused rather than held for ten minutes", async () => {
    let calls = 0;
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async () => {
            calls += 1;
            return Array.from({ length: WHOLE_LISTING }, (_, index) => ({
              slug: `app_${index}`,
              name: `App ${index}`,
              meta: {},
            }));
          },
        },
      }),
      () => 1_000_000,
    );

    /*
     * `LISTING_LIMIT` is the largest page the toolkit endpoint allows and the SDK drops the
     * response's cursor, so a catalogue of exactly this size and one larger answer identically.
     * Committed, the fragment would be served for ten minutes to the picker AND to the enable
     * route, which tells an administrator that a real app "is not an app Composio lists".
     */
    await expect(broker.listApps()).rejects.toThrow(/largest page/);
    // And the refusal is not what gets held: the next caller asks again.
    await expect(broker.listApps()).rejects.toThrow(/largest page/);
    expect(calls).toBe(2);
  });

  test("each caller gets its own rows, so one of them cannot edit the cache", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        toolkits: {
          get: async () => [
            {
              slug: "gmail",
              name: "Gmail",
              meta: {
                description: "Send and read mail.",
                categories: [{ slug: "productivity", name: "Productivity" }],
                toolsCount: 63,
              },
            },
          ],
        },
      }),
      () => 1_000_000,
    );

    const first = await broker.listApps();
    first[0].name = "Not Gmail";
    first[0].categories.push("Invented");
    first.length = 0;

    // Nothing does this today, which is exactly why leaving it would be a trap: the first caller
    // that sorts or trims the rows would be editing what the next nine minutes of callers read as
    // Composio's answer, and the fault would surface in somebody else's request.
    const second = await broker.listApps();
    expect(second).toEqual([
      {
        slug: "gmail",
        name: "Gmail",
        description: "Send and read mail.",
        logo: null,
        categories: ["Productivity"],
        actionCount: 63,
      },
    ]);
  });
});

/**
 * WHAT ESCAPES THE SEAM WHEN THE VENDOR THROWS, asked of every method the seam has.
 *
 * ONE TABLE RATHER THAN A TEST PER DISCOVERY, because the defect this is about has been found four
 * times in four methods and each finding was fixed where it was pointed at. `routes.ts` answers a
 * thrown broker error by reaching into it for the vendor's own sentence and, finding none, telling
 * the reader that Composio said nothing about why and that an administrator should check this
 * deployment's Composio key. That is the right thing to say about a socket that hung up and the
 * wrong thing to say about every failure the vendor actually explained — and which of the two a
 * reader gets is decided by whether the `await vendor.*` that threw happened to sit inside
 * something that translates. TypeScript has no checked exceptions, so nothing enumerates the calls
 * that do and nothing notices a new one that does not.
 *
 * THE PROPERTY, STATED ONCE: an error leaving this seam must leave the route something to say —
 * either a {@link BrokerRefusalError}, whose sentence this deployment wrote and whose remedy is
 * already in it, or a vendor error whose own sentence {@link vendorSentence} can reach. Anything
 * else reaches the reader as "check your Composio key", so anything else has to be named below as
 * a failure that genuinely deserves that answer.
 *
 * THE ALLOW-LIST IS ASSERTED IN BOTH DIRECTIONS, which is what stops it becoming a list of
 * excuses. An entry on it must actually arrive unexplained; the day a method starts translating
 * the failure named there, its entry reddens and has to be deleted rather than quietly outliving
 * the state it describes.
 *
 * THE METHOD LIST IS THE SEAM'S OWN. It is read off the objects {@link buildComposioClient}
 * returns rather than copied into this file, and typed as `keyof ComposioBroker | keyof
 * ComposioActions`, so a method added to either seam with no entry here fails the completeness
 * test below instead of being covered by nobody.
 */
describe("what a vendor failure becomes on its way out of the seam", () => {
  /**
   * The two ways a vendor call fails, which are two different questions and not one.
   *
   * An OUTAGE carries nothing: a socket, a 502 from an edge, a timeout. Nobody wrote a sentence
   * about it, so there is none to find and "Composio did not say why" is the honest answer.
   *
   * A NAMED CONDITION is the opposite case and the one that keeps being missed. `@composio/core`
   * raises its own error classes — `ComposioMultipleConnectedAccountsError` and the four others
   * down the same door: `ComposioAclOnlyForSharedError`,
   * `ComposioFailedToCreateConnectedAccountLink`, `ValidationError`,
   * `ComposioRequestCancelledError` — and each one is the vendor saying WHICH condition happened,
   * in a message it wrote for a reader. None of it is nested where {@link vendorSentence} looks, so
   * a seam that lets one through unexamined converts an explanation into "check the key".
   *
   * A SHAPE THE SDK ITSELF COULD NOT READ is the third, and it is the one three rounds of review
   * wrote guards for at the wrong layer. `@composio/core` 0.18.1 does not hand a malformed listing
   * over to be inspected: its own transformers dereference the answer first, so
   * `response.items.map(transformAuthConfigRetrieveResponse)` off a bare list, and
   * `authConfig.toolkit.logo` off a row that is not an object, raise a bare `TypeError` from inside
   * the vendor's code before any reader here is reached (`src/utils/transformers/authConfigs.ts:79`,
   * `:41`, and the same two shapes in `connectedAccounts.ts:113`, `:60` and `models/Tools.ts:561`).
   * A `TypeError` arriving out of an `await vendor.*` is therefore Composio's shape and not a bug of
   * this deployment's, and what it needs is the same thing every other vendor failure needs: a
   * sentence.
   */
  const THROWN: {
    kind: string;
    raise: () => Error;
    /** What the sentence must say, where the kind of failure settles a remedy. */
    demands?: RegExp;
    /** What the sentence must not have picked up from the error it translated. */
    quiets?: RegExp;
  }[] = [
    {
      kind: "an outage",
      raise: () => new Error("socket hang up"),
    },
    {
      kind: "a named vendor condition",
      raise: () =>
        Object.assign(
          new Error(
            "Multiple connected accounts found for user user_1 and toolkit linear.",
          ),
          { name: "ComposioMultipleConnectedAccountsError" },
        ),
    },
    {
      kind: "a shape the SDK itself could not read",
      raise: () =>
        new TypeError(
          "undefined is not an object (evaluating 'response.items.map')",
        ),
      // One remedy, and it is a package rather than a page: nobody operating this deployment can
      // correct what Composio answers, and the key is demonstrably fine — the call went out.
      demands: /@composio\/core/,
      quiets: A_CRASH,
    },
  ];

  type SeamMethod = keyof ComposioBroker | keyof ComposioActions;

  /**
   * The failures this seam is allowed to hand on unexplained, one entry per state and each with
   * its reason written down.
   *
   * Every one of them is the same claim: the vendor call that failed said nothing this deployment
   * could pass on, so "Composio did not answer and an administrator should check the key and their
   * status page" is genuinely the best thing a reader can be told. That claim is true of a bare
   * `Error` out of a listing and it is NOT true of anything the vendor named.
   */
  const GENUINE_OUTAGES: {
    method: SeamMethod;
    kind: string;
    because: string;
  }[] = [
    {
      method: "listApps",
      kind: "an outage",
      because:
        "The catalogue did not answer. There is no app and no person in the question, so the only remedy is the deployment's key or the vendor's status page.",
    },
    {
      method: "ensureAuthConfig",
      kind: "an outage",
      because:
        "Creating the config failed with nothing said. An administrator pressed Add; the app is not enabled, and what to check is the key.",
    },
    {
      method: "authorize",
      kind: "an outage",
      because:
        "Minting the link failed with nothing said. Nobody was sent anywhere and nothing was attached, so trying again is the whole of the advice.",
    },
    {
      method: "isConnected",
      kind: "an outage",
      because:
        "The account listing did not answer. This is a gate rather than a page, and its caller refuses the run either way.",
    },
    /*
     * THE TWO REASONS BELOW USED TO BE FALSE, AND THIS IS THE CASE THE ALLOW-LIST CANNOT CATCH BY
     * ITSELF. Its assertion asks whether an AUTHORED sentence reached the reader, so an entry whose
     * `because` mis-describes what the reader gets INSTEAD stays green for ever. Both of these said
     * the app gets named somewhere downstream; neither does. `listingSentence` returns the thrown
     * message verbatim whenever it is neither a schema mismatch nor the vendor's placeholder
     * (`./composio`), and `callTool` does the same on the execute path — so "socket hang up" reaches
     * an administrator's Plugins page and a model's context exactly like that, bare, naming no app.
     * The entries now say so, and the `allowed` branch of the test asserts the message travels
     * untouched, which is what makes the claim hold itself up.
     */
    {
      method: "listActions",
      kind: "an outage",
      because:
        "The action listing did not answer. `./composio`'s `listingSentence` passes the thrown message on verbatim, so the reader gets the vendor's own bare words with no app named — which is all there is, because a listing that did not answer leaves nothing else to say.",
    },
    {
      method: "execute",
      kind: "an outage",
      because:
        "The call itself failed with nothing said. `callTool` passes the thrown message on verbatim unless it is the vendor's placeholder, so the reader gets the vendor's own bare words — the app is named by the connection they pressed, not by this sentence.",
    },
  ];
  const UNEXPLAINABLE = new Set(
    GENUINE_OUTAGES.map((outage) => `${outage.method}/${outage.kind}`),
  );

  /**
   * Every method of the seam, with the vendor call that decides its answer aimed at the throw.
   *
   * THE CALL THAT DECIDES RATHER THAN THE FIRST ONE. Several of these read a listing before they
   * do the thing they are named for, and a vendor whose every method threw would have each of them
   * fail at that first read — so the table would be eight tests of one listing and F1, which lives
   * behind an auth-config listing that succeeds, would be unreachable. Each entry below answers
   * everything on the way in and throws at the step the method exists to perform.
   */
  const SEAM_CASES: {
    method: SeamMethod;
    vendor: (raise: () => Promise<never>) => Parameters<typeof fakeVendor>[0];
    ask: (client: ReturnType<typeof buildComposioClient>) => Promise<unknown>;
  }[] = [
    {
      method: "listApps",
      vendor: (raise) => ({ toolkits: { get: raise } }),
      ask: ({ broker }) => broker.listApps(),
    },
    {
      method: "ensureAuthConfig",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [] }), create: raise },
      }),
      ask: ({ broker }) =>
        broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" }),
    },
    {
      method: "deleteAuthConfig",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [OURS] }), delete: raise },
      }),
      ask: ({ broker }) => broker.deleteAuthConfig("linear"),
    },
    {
      method: "authorize",
      vendor: (raise) => ({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { link: raise },
      }),
      ask: ({ broker }) =>
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
    },
    {
      method: "isConnected",
      vendor: (raise) => ({ connectedAccounts: { list: raise } }),
      ask: ({ broker }) =>
        broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    },
    {
      method: "revoke",
      vendor: (raise) => ({
        // The configs first, because the withdrawal reads them to find out which accounts are this
        // deployment's to end before it asks for any account at all.
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: raise,
        },
      }),
      ask: ({ broker }) =>
        broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    },
    {
      method: "listActions",
      vendor: (raise) => ({ tools: { getRawComposioTools: raise } }),
      ask: ({ actions }) =>
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
    },
    {
      method: "execute",
      vendor: (raise) => ({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            toolkit: { slug: "gmail" },
          }),
          execute: raise,
        },
      }),
      ask: ({ actions }) =>
        actions.execute(
          {
            toolkit: "gmail",
            slug: "GMAIL_FETCH_EMAILS",
            userId: "user_1",
            version: "20260903_00",
          },
          {},
        ),
    },
  ];

  test("every method the seam offers has an entry in the table", () => {
    // Read off the built objects rather than listed here a second time: a method added to either
    // projection arrives in this set, and the table that does not cover it fails here rather than
    // being the one door nobody thought to probe.
    const seam = buildComposioClient(fakeVendor({}));
    expect(
      [...Object.keys(seam.broker), ...Object.keys(seam.actions)].sort(),
    ).toEqual(SEAM_CASES.map((seamCase) => seamCase.method).sort());
  });

  for (const seamCase of SEAM_CASES) {
    for (const thrown of THROWN) {
      const allowed = UNEXPLAINABLE.has(`${seamCase.method}/${thrown.kind}`);
      test(`${seamCase.method} meeting ${thrown.kind} leaves the route ${
        allowed
          ? "nothing to say, and that is named as an outage"
          : "a sentence"
      }`, async () => {
        const raised = thrown.raise();
        const client = buildComposioClient(
          fakeVendor(
            seamCase.vendor(async () => {
              throw raised;
            }),
          ),
          () => 1_000_000,
        );

        const escaped = await failureOf(seamCase.ask(client));
        const sentence = brokerSentence(escaped) ?? vendorSentence(escaped);

        if (allowed) {
          // The allow-list's other direction. This entry claims the reader cannot be told anything
          // useful here; the day that stops being true, this line is what says so.
          expect(sentence).toBeNull();
          /*
           * AND WHAT THE READER DOES GET, WHICH IS THE HALF THE `because` COLUMN KEPT GETTING WRONG.
           * Two entries above used to claim the reader is left with a named app and only the reason
           * missing; the truth is that the vendor's own bare message travels on untouched — through
           * `listingSentence` into an app's `lastError`, and through `callTool` into a result — with
           * nothing added and no app named. That is what "unexplainable" costs here, so the entries
           * say so and this line holds them to it: the day a method starts wrapping the failure, the
           * `because` beside it stops being true and this reddens rather than outliving it.
           */
          expect(escaped.message).toBe(raised.message);
          return;
        }
        expect(sentence).not.toBeNull();
        expect(sentence?.trim()).not.toBe("");
        /*
         * THE REMEDY IS ASKED OF THE WHOLE FAILURE AND NOT OF ITS FIRST LINE, because two of these
         * methods deliberately make a COUNT their sentence. `revoke` and `deleteAuthConfig` are
         * withdrawing a SET, and what a reader can act on there is how many of it survived; every
         * reason the loop met travels on `cause` instead, which is the only place the detail lives.
         * So what has to be true is that the remedy reached the failure somewhere, and reading the
         * chain is what says so for both shapes at once.
         */
        if (thrown.demands) {
          expect(everythingSaidBy(escaped).join("\n")).toMatch(thrown.demands);
        }
        // The vendor's crash is carried as `cause` and never quoted: a sentence that reads like a
        // stack trace is the thing every refusal in this seam was written to stop being.
        if (thrown.quiets) expect(sentence).not.toMatch(thrown.quiets);
      });
    }
  }
});

/**
 * ONE REMEDY PER VENDOR CONDITION, WHICH IS THE HALF THE TABLE ABOVE CANNOT ASSERT.
 *
 * That table asks whether a reader is told ANYTHING, and a seam that answered every named condition
 * with one sentence would satisfy it completely. This file has already been bitten by exactly that:
 * `rejects.toThrow(/linear/)` matched three authored refusals prescribing three different acts by
 * three different people, so deleting a whole branch left the suite green. The app name is the part
 * every sentence shares; the remedy is the part that makes a sentence worth writing.
 *
 * SO EACH ROW BELOW IS ASSERTED IN BOTH DIRECTIONS: the sentence a condition produces must carry ITS
 * remedy and must carry NO OTHER ROW'S. Two conditions collapsed into one wording fail here twice
 * over — the row that lost its remedy, and the row that acquired a second one.
 *
 * THE CALL SITE OF EACH ROW IS ONE THAT ACTUALLY RAISES IT, read off `@composio/core` 0.18.1 rather
 * than chosen for convenience, so a row is also a record of where its condition comes from. The
 * table above already establishes that the translation is not call-site-specific; this one
 * establishes that the sentences are distinguishable, which is what stops the translation being a
 * fallback with a vendor's name on it.
 */
describe("each vendor condition reaches the reader as its own remedy", () => {
  /** The vendor's error as it arrives: a name, and a message nothing here reads. */
  function raising(name: string): () => Promise<never> {
    return async (): Promise<never> => {
      throw Object.assign(new Error(`${name} came out of Composio.`), { name });
    };
  }

  /** Minting this person's connect link, which is where three of the rows below come from. */
  function whileLinking(raise: () => Promise<never>): Promise<unknown> {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: { link: raise },
      }),
      () => 1_000_000,
    );
    return broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });
  }

  /** Creating this deployment's auth config, where the SDK parses what it is handed. */
  function whileCreatingConfig(raise: () => Promise<never>): Promise<unknown> {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [] }), create: raise },
      }),
      () => 1_000_000,
    );
    return broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" });
  }

  /**
   * ONE APP ACROSS ALL FOUR CONTEXTS, WHICH IS WHAT MAKES THE CROSS-CHECK BELOW MEAN ANYTHING.
   *
   * Three of these remedies name the app they are about. The linking and creating contexts were
   * about `linear` and the resolving and running ones about `gmail`, so "this sentence does not
   * also prescribe somebody else's step" was being asked with a regular expression naming an app
   * the sentence could not have mentioned — it passed for every pair that crossed the two contexts
   * for a reason that had nothing to do with the sentences, which is most of the table. One app
   * makes every row comparable with every other.
   */
  const CALL = {
    toolkit: "linear",
    slug: "LINEAR_CREATE_ISSUE",
    userId: "user_1",
    version: "20260903_00",
  };

  /** Resolving the tool before it is run, which is the call that reports a withdrawn action. */
  function whileResolving(raise: () => Promise<never>): Promise<unknown> {
    const { actions } = buildComposioClient(
      fakeVendor({ tools: { getRawComposioToolBySlug: raise } }),
      () => 1_000_000,
    );
    return actions.execute(CALL, {});
  }

  /** Running it, once the resolve has already agreed about which app it belongs to. */
  function whileRunning(raise: () => Promise<never>): Promise<unknown> {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: CALL.slug,
            toolkit: { slug: CALL.toolkit },
          }),
          execute: raise,
        },
      }),
      () => 1_000_000,
    );
    return actions.execute(CALL, {});
  }

  const CONDITIONS: {
    name: string;
    raisedBy: string;
    remedy: RegExp;
    ask: (raise: () => Promise<never>) => Promise<unknown>;
  }[] = [
    {
      name: "ComposioMultipleConnectedAccountsError",
      raisedBy: "connectedAccounts.link",
      remedy: /disconnecting the account they already hold/,
      ask: whileLinking,
    },
    {
      name: "ComposioAclOnlyForSharedError",
      raisedBy: "connectedAccounts.link",
      remedy: /changing how linear is shared in Composio's own dashboard/,
      ask: whileLinking,
    },
    {
      name: "ComposioFailedToCreateConnectedAccountLink",
      raisedBy: "connectedAccounts.link",
      remedy: /no consent was spent/,
      ask: whileLinking,
    },
    {
      name: "ValidationError",
      raisedBy: "authConfigs.create",
      remedy: /upgrading this deployment's @composio\/core/,
      ask: whileCreatingConfig,
    },
    {
      name: "ComposioRequestCancelledError",
      raisedBy: "tools.execute",
      remedy: /asking for it again is what settles/,
      ask: whileRunning,
    },
    {
      name: "ComposioConnectedAccountNotFoundError",
      raisedBy: "tools.execute",
      remedy:
        /connecting linear again on this deployment's Connected accounts page/,
      ask: whileRunning,
    },
    {
      name: "ComposioToolNotFoundError",
      raisedBy: "tools.getRawComposioToolBySlug",
      remedy: /records what Composio publishes now/,
      ask: whileResolving,
    },
    {
      name: "ComposioToolVersionRequiredError",
      raisedBy: "tools.execute",
      remedy: /replaces "latest" with a version Composio will accept/,
      ask: whileRunning,
    },
  ];

  for (const condition of CONDITIONS) {
    test(`${condition.name} out of ${condition.raisedBy} prescribes its own step`, async () => {
      const failure = await failureOf(condition.ask(raising(condition.name)));
      const sentence = brokerSentence(failure) ?? vendorSentence(failure);

      expect(sentence).not.toBeNull();
      expect(sentence).toMatch(condition.remedy);

      // The other direction: a sentence that also prescribes somebody else's step is a sentence two
      // conditions are sharing, which is the state this whole table exists to catch.
      for (const other of CONDITIONS) {
        if (other.name === condition.name) continue;
        expect(sentence).not.toMatch(other.remedy);
      }
    });
  }

  /**
   * ONE VENDOR CLASS OVER EVERY WAY A FETCH CAN FAIL, which is a fact about the SDK rather than a
   * reading of its name. `getRawComposioToolBySlug` wraps its retrieve in a try whose catch
   * rethrows everything except a cancellation as `ComposioToolNotFoundError` (`@composio/core`
   * 0.18.1, `src/models/Tools.ts:709-721`), and `tools.execute` resolves through that same method
   * (`:1163`). A 500, a 429, a refused key and a socket that hung up therefore all arrive wearing
   * the name of an action that was withdrawn — and the sentence read the name as the finding,
   * telling an administrator during an outage that Composio no longer publishes their action and
   * that pressing Refresh at the vendor that is not answering will fix it.
   */
  test("the withdrawn-action condition does not claim to know Composio withdrew anything", async () => {
    const failure = await failureOf(
      whileResolving(raising("ComposioToolNotFoundError")),
    );
    const sentence = brokerSentence(failure);

    expect(sentence).not.toBeNull();
    // The refresh stays, because a withdrawn action is the commonest of them and the refresh is
    // the only act that settles that reading.
    expect(sentence).toMatch(/records what Composio publishes now/);
    // What was missing is the other reading, and the fact that separates the two — which is
    // something an administrator can go and look at.
    expect(sentence).toMatch(
      /a timeout, a dropped connection, a 500, a refused key/,
    );
    expect(sentence).toMatch(/says nothing that tells the two apart/);
    // And the claim it must no longer make.
    expect(sentence).not.toMatch(/no longer publishes that action/);
  });

  /**
   * The vendor's own words win where there are any, which is the limit on translating at all.
   *
   * `routes.ts` reads {@link brokerSentence} first and {@link vendorSentence} second, so a refusal
   * authored here HIDES whatever Composio's own server said. Several of the SDK's classes are
   * wrappers that carry the server's explanation underneath — `ComposioFailedToCreateConnectedAccountLink`
   * is one, and it is on the table above — so translating one of those unconditionally would replace
   * a specific server message with this deployment's general one. Where the vendor explained itself,
   * the error is passed on untouched and the reader gets the vendor's sentence.
   */
  test("a condition whose vendor message is reachable is passed on rather than reworded", async () => {
    const failure = await failureOf(
      whileLinking(async (): Promise<never> => {
        throw Object.assign(
          new Error("Failed to create connected account link"),
          {
            name: "ComposioFailedToCreateConnectedAccountLink",
            cause: {
              error: {
                error: {
                  message:
                    "The auth config linear (OpenBot) has no redirect URI registered.",
                },
              },
            },
          },
        );
      }),
    );

    expect(brokerSentence(failure)).toBeNull();
    expect(vendorSentence(failure)).toBe(
      "The auth config linear (OpenBot) has no redirect URI registered.",
    );
  });
});

/**
 * WHAT THE LOOP THAT DELETES A SET OF THINGS DOES WITH WHAT IT CATCHES.
 *
 * `deleteAuthConfig` and `revoke` each ask Composio to end several objects that independently hold
 * somebody's access, and both attempt all of them rather than stopping at the first refusal — which
 * is the right shape and was reporting almost none of what it learned. Two things were wrong with
 * it, and they are different failures rather than one.
 *
 * EVERY REASON AFTER THE FIRST WAS DISCARDED. The throw carried `cause: refused[0]` and nothing
 * else, so a person with five accounts of which three refused left one reason behind and two gone —
 * and the sentence a reader gets is a count, deliberately, so the reasons were the only place the
 * detail lived at all.
 *
 * AND A BUG OF OURS WAS COUNTED AS A REFUSAL BY COMPOSIO. The catch took everything, so a
 * `TypeError` out of this adapter's own code became one more "Composio refused the rest" — a
 * sentence telling an operator to press disconnect again, about a fault that will do the same thing
 * every time and that no amount of retrying reaches.
 */
describe("what the delete loop keeps of the failures it meets", () => {
  test("every account Composio refused is carried, not only the first", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id !== "ca_1") throw new Error(`Composio refused ${id}.`);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The sentence stays the count, which is what a reader can act on. The reasons are what a log
    // reader needs, and there are two of them.
    expect(brokerSentence(failure)).toMatch(/1 of this person's 3 accounts/);
    const cause = failure.cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(
      (cause as AggregateError).errors.map((one) => (one as Error).message),
    ).toEqual(["Composio refused ca_2.", "Composio refused ca_3."]);
  });

  test("a single refusal is still carried as itself rather than wrapped", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    expect((failure.cause as Error).message).toBe("Composio refused that one.");
  });

  /**
   * A `TypeError` OUT OF A VENDOR CALL IS COMPOSIO'S SHAPE, AND THIS TEST USED TO ASSERT THE REVERSE.
   *
   * It was written around `isOurFault`, whose premise was that a `TypeError` is what a mistake in
   * this file looks like and never something "Composio can reply". Running `@composio/core` 0.18.1
   * falsifies that premise outright: a bare list where `{ items }` belongs, an envelope whose
   * `items` is a string, and a row that is not an object all raise a bare `TypeError` from inside
   * the vendor's own transformers, before any code here is reached. So the classification was
   * inverted — a vendor fault escaped the loop as a bug of ours, abandoning every account after it
   * unasked, and the reader was told nothing at all.
   *
   * WHICH IS WHY THE GUARD MOVED RATHER THAN BEING RETUNED. `askVendor` wraps the `await vendor.*`
   * and nothing else, so "the fault surfaced inside the vendor's code" is a fact about the call
   * stack there rather than a guess from an error class; the loop no longer has to tell the two
   * apart, because by the time an error reaches it the question has been answered one layer down.
   */
  test("a shape the SDK could not read is Composio refusing, and the loop goes on", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") {
              throw new TypeError(
                "undefined is not an object (evaluating 'x')",
              );
            }
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // The third account is the one the old classification abandoned: a `TypeError` at the second
    // escaped the loop, so a live grant was never asked about and nothing in the answer said so.
    expect(deleted).toEqual(["ca_1", "ca_3"]);
    expect(brokerSentence(failure)).toMatch(/2 of this person's 3 accounts/);
    // And the crash is carried rather than quoted: the sentence a person reads is this
    // deployment's, and the vendor's own words are on `cause` for whoever is reading a log.
    expect(failure.message).not.toMatch(A_CRASH);
    expect((failure.cause as Error).cause).toBeInstanceOf(TypeError);
  });

  test("the same two promises hold for the loop that removes an app's configs", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [OURS, OURS_SPARE] }),
          delete: async (id: string) => {
            throw new Error(`Composio refused ${id}.`);
          },
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(broker.deleteAuthConfig("linear"));

    expect(brokerSentence(failure)).toMatch(
      /0 of this deployment's 2 authorization configs/,
    );
    expect(
      (failure.cause as AggregateError).errors.map(
        (one) => (one as Error).message,
      ),
    ).toEqual(["Composio refused ac_ours.", "Composio refused ac_ours_spare."]);
  });
});

/**
 * WHAT EACH VENDOR LISTING IS ALLOWED TO BE, given that this file's types only assert its shape.
 *
 * A TYPESCRIPT INTERFACE OVER A WIRE VALUE IS AN ASSERTION AND NOT A CHECK, which is the reason
 * this table exists — but only for the fields, and that distinction is the whole of what a round of
 * running `@composio/core` 0.18.1 established. Three of these four listings go through the SDK's
 * warn-only `transform()`, which logs a `safeParse` failure and returns the unvalidated object, so a
 * toolkit whose name is null, an auth config whose id is missing and a connected account with no id
 * all arrive here exactly as they came off the wire. Those are the shapes below, and each one was
 * OBSERVED arriving rather than reasoned about.
 *
 * WHAT IS NOT BELOW ANY MORE IS THE CONTAINER, AND THAT IS A CORRECTION RATHER THAN A GAP. This
 * table used to open each listing with "nothing at all" and "a bare list where an envelope belongs",
 * on the claim that those had been observed too. They had not, and they cannot be: every one of the
 * SDK's list transformers dereferences the answer before returning it — `response.items.map(...)`
 * for the two paged listings and for the tool list, `item.meta.categories` for the catalogue — so a
 * container of the wrong shape dies inside the vendor's code, as a bare `TypeError` on three paths
 * and as `ComposioToolkitFetchError` on the catalogue, before any reader in the adapter is reached.
 * That failure is a vendor-shape fault and is answered as one, which is asserted next door in the
 * seam table rather than pretended at here.
 *
 * WHAT A MALFORMED ANSWER MUST NOT BECOME IS A CRASH REPORT. `f.toLowerCase is not a function` and
 * `null is not an object` are what these produce without a reader: the first as an unhandled 500 on
 * a live route, the rest as a 502 telling an administrator to check a key that is perfectly good. So
 * each case asserts that the call refuses, and that the refusal is a sentence rather than the name
 * of a method that was not there.
 *
 * ASSERTED AS A PROPERTY AND NOT AS A WORDING, because what is required is that a reader be told
 * something, and that nothing be sent to the vendor on the strength of a field the answer did not
 * carry. The second half is the one that had rotted: `sent` was a literal empty array in half these
 * cases and no stub ever wrote to it, so the assertion holding it was a tautology dressed as a
 * check. It is now every vendor call the adapter made, in order, and each listing says which single
 * call that should be.
 */
describe("a vendor listing that is not the shape it is declared to be", () => {
  /** Every vendor method the adapter reached, named, in the order it was called. */
  type Probe = {
    parts: Parameters<typeof fakeVendor>[0];
    sent: string[];
  };

  const MALFORMED_LISTINGS: {
    listing: string;
    answers: { shape: string; answer: unknown }[];
    probe: (answer: unknown) => Probe;
    /** The one call this listing's fault is allowed to have made before it refused. */
    asked: string[];
    ask: (client: ReturnType<typeof buildComposioClient>) => Promise<unknown>;
    /** Whether the refusal has to be one a route passes through as this deployment's own. */
    authored: boolean;
  }[] = [
    {
      listing: "the app catalogue",
      answers: [
        {
          shape: "a row whose slug is null",
          answer: [{ slug: null, name: "Gmail", meta: {} }],
        },
        {
          shape: "a row whose name is null",
          answer: [{ slug: "gmail", name: null, meta: {} }],
        },
        {
          shape: "a category the vendor named with nothing",
          answer: [
            { slug: "gmail", name: "Gmail", meta: { categories: [{}] } },
          ],
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            toolkits: {
              get: async () => {
                sent.push("toolkits.get");
                return answer;
              },
            },
          },
          sent,
        };
      },
      asked: ["toolkits.get"],
      ask: ({ broker }) => broker.listApps(),
      authored: true,
    },
    {
      listing: "this app's auth configs",
      answers: [
        {
          shape: "a row with no name",
          answer: { items: [{ id: "ac_ours", status: "ENABLED" }] },
        },
        {
          shape: "a row whose id is null",
          answer: {
            items: [{ id: null, name: "Linear (OpenBot)", status: "ENABLED" }],
          },
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            authConfigs: {
              list: async () => {
                sent.push("authConfigs.list");
                return answer;
              },
            },
            connectedAccounts: {
              link: async () => {
                sent.push("connectedAccounts.link");
                return { redirectUrl: "https://backend.composio.dev/s/a-link" };
              },
            },
          },
          sent,
        };
      },
      asked: ["authConfigs.list"],
      ask: ({ broker }) =>
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
      authored: true,
    },
    {
      listing: "this person's accounts",
      answers: [
        { shape: "a row with no id", answer: { items: [{}] } },
        { shape: "a row whose id is null", answer: { items: [{ id: null }] } },
        { shape: "a row whose id is a number", answer: { items: [{ id: 7 }] } },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            authConfigs: {
              list: async () => {
                sent.push("authConfigs.list");
                return { items: [OUR_GMAIL] };
              },
            },
            connectedAccounts: {
              list: async () => {
                sent.push("connectedAccounts.list");
                return answer;
              },
              delete: async () => {
                sent.push("connectedAccounts.delete");
              },
            },
          },
          sent,
        };
      },
      // The whole listing is unreadable here, so there is no readable grant to withdraw and the
      // delete must not be reached at all — a withdrawal of `undefined` is the request this refusal
      // exists to stop being made. Where SOME rows are readable the answer is different and the
      // test for it sits beside `revoke`: those go, and the sentence counts what was left.
      //
      // The config listing goes out first because the withdrawal is scoped to this deployment's own
      // configs before it asks for an account at all; it is named here rather than left out so that
      // the assertion stays a statement about the whole conversation with the vendor.
      asked: ["authConfigs.list", "connectedAccounts.list"],
      ask: ({ broker }) =>
        broker.revoke({ userId: "user_1", toolkit: "gmail" }),
      authored: true,
    },
    {
      listing: "this app's actions",
      answers: [
        // The one row fault `ToolSchema` admits: `z.string()` is satisfied by the empty string, and
        // an action's slug is `mcp_tools.name` — NOT NULL and half the primary key — as well as
        // what a later call sends back to Composio.
        {
          shape: "an action whose slug is empty",
          answer: [{ slug: "", name: "Fetch emails" }],
        },
      ],
      probe: (answer) => {
        const sent: string[] = [];
        return {
          parts: {
            tools: {
              getRawComposioTools: async () => {
                sent.push("tools.getRawComposioTools");
                return answer;
              },
            },
          },
          sent,
        };
      },
      asked: ["tools.getRawComposioTools"],
      ask: ({ actions }) =>
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
      // `./composio` authors this one's sentence, not `./broker`: a listing failure is recorded in
      // the app's `lastError` rather than answered to a route, so what is required here is a
      // sentence and not a class.
      authored: false,
    },
  ];

  for (const listing of MALFORMED_LISTINGS) {
    for (const { shape, answer } of listing.answers) {
      test(`${listing.listing} answered with ${shape} is refused in a sentence`, async () => {
        const probe = listing.probe(answer);
        const client = buildComposioClient(
          fakeVendor(probe.parts),
          () => 1_000_000,
        );

        const failure = await failureOf(listing.ask(client));

        expect(failure.message).not.toMatch(A_CRASH);
        expect(failure.message.trim()).not.toBe("");
        if (listing.authored) {
          expect(brokerSentence(failure)).not.toBeNull();
        }
        // Nothing was sent to the vendor on the strength of a field the answer did not carry: an
        // id-less account reaching the delete is a request to withdraw `undefined`, which the
        // vendor is free to read as anything at all. The listing itself is what SHOULD have gone
        // out, so the assertion names it rather than asking for silence — an adapter that stopped
        // asking at all would satisfy an empty expectation perfectly.
        expect(probe.sent).toEqual(listing.asked);
      });
    }
  }
});

/**
 * A listing that came back at the page ceiling, and what a caller may conclude from it.
 *
 * THE TWO LISTINGS HERE CARRY A CURSOR AND THE CATALOGUE DOES NOT, which is why they are answered
 * differently from the fragment refusal next door. `AuthConfigListParamsSchema` and
 * `ConnectedAccountListParamsSchema` both name a `cursor` (`@composio/core` 0.18.1,
 * `src/types/authConfigs.types.ts:124-131` and `src/types/connectedAccounts.types.ts:259-266`),
 * both models forward it (`src/models/AuthConfigs.ts:95`, `src/models/ConnectedAccounts.ts:118`),
 * and both transformers fill `nextCursor` in from the response
 * (`src/utils/transformers/authConfigs.ts:80`, `connectedAccounts.ts:116`). The toolkit listing has
 * none of that — its response is a bare array with the cursor dropped before any caller sees it —
 * so there the only honest answer is to refuse, and here it is to go and read the rest.
 *
 * WHAT IS ACTUALLY BEING PROTECTED IS `revoke`'s `true`. It means "this person's access has ended",
 * and `store.ts` writes that into the audit trail and then deletes the one row naming which app they
 * had connected. One page of their accounts is not the set of their accounts, so the assertions
 * below are on WHAT WENT OUT — every account, from every page — rather than on what came back: an
 * implementation that read one page answers `true` just as confidently.
 */
describe("a listing that arrived with a cursor still outstanding", () => {
  /** The statuses the revoke asks about, spelled once for the two queries asserted below. */
  const REVOCABLE_STATUSES = [
    "INITIALIZING",
    "INITIATED",
    "ACTIVE",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
  ];

  test("every page of this person's accounts is read, and every account on them withdrawn", async () => {
    const asked: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [{ id: "ca_1" }], nextCursor: "page_2" }
              : { items: [{ id: "ca_2" }], nextCursor: null };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );

    // `ca_2` is the whole test. It is on the second page, so a reader that stopped at the first
    // deletes `ca_1`, answers `true`, and leaves a live grant behind an audit row saying this
    // person's access ended.
    expect(deleted).toEqual(["ca_1", "ca_2"]);
    // The first request carries no cursor at all, and the second carries the vendor's own word for
    // where it left off — which is the half a reader cannot infer from the rows that came back.
    expect(asked).toEqual([
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: REVOCABLE_STATUSES,
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
      },
      {
        userIds: ["user_1"],
        toolkitSlugs: ["gmail"],
        statuses: REVOCABLE_STATUSES,
        accountType: "ALL",
        authConfigIds: [OUR_GMAIL.id],
        limit: WHOLE_LISTING,
        cursor: "page_2",
      },
    ]);
  });

  test("an account on a later page still decides whether somebody is connected", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [], nextCursor: "page_2" }
              : { items: [{ id: "ca_2" }], nextCursor: null },
        },
      }),
    );

    // A first page that is empty with a cursor still outstanding is exactly the shape that reads as
    // "this person has no account", which then tells them to connect an app they already hold — and
    // tells the gate in `./access` that they may not act through one they can.
    expect(
      await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    ).toBe(true);
  });

  /**
   * A YES/NO QUESTION THAT PAGING MADE FAILABLE, WHICH IS THE OTHER HALF OF THE TEST ABOVE.
   *
   * Reading every page is what makes `isConnected`'s `false` honest, and it is also what put the
   * two cursor refusals and the page ceiling in front of a person whose ACTIVE account had already
   * been found. `true` is settled the moment one row arrives — no cursor Composio sends next and no
   * fiftieth page can turn it into anything else — so a fault on a page nobody needed was deciding
   * the answer to a question nobody still had. And the consequence is not a wasted request:
   * `store.ts` DELETES this person's `composio_connections` row on anything other than a `true`,
   * and the route turns the refusal into "Composio's answer could not be read" over an account that
   * is right there on page one.
   *
   * THE THREE FAULTS ARE ASSERTED SEPARATELY, because they are three different branches of
   * `everyRowOf` and an early stop that closed one of them would be green on a test that only asked
   * about another.
   */
  for (const { fault, pages } of [
    {
      fault: "a cursor that is not a cursor",
      pages: () => async () => ({ items: [{ id: "ca_1" }], nextCursor: 7 }),
    },
    {
      fault: "a cursor that never advances",
      pages: () => async () => ({
        items: [{ id: "ca_1" }],
        nextCursor: "page_2",
      }),
    },
    {
      fault: "a cursor that advances for ever",
      pages: () => {
        let page = 0;
        return async () => ({
          items: [{ id: `ca_${++page}` }],
          nextCursor: `page_${page + 1}`,
        });
      },
    },
  ]) {
    test(`${fault} cannot unanswer a connection the first page proved`, async () => {
      let asked = 0;
      const page = pages();
      const { broker } = buildComposioClient(
        fakeVendor({
          connectedAccounts: {
            list: async () => {
              asked += 1;
              return page();
            },
          },
        }),
        () => 1_000_000,
      );

      expect(
        await broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
      ).toBe(true);
      // One request, because the first answer settled it. Counted rather than left implicit: an
      // implementation that read on and happened not to throw would answer `true` as well, and the
      // whole point is that the later pages are never reached.
      expect(asked).toBe(1);
    });
  }

  /**
   * AND THE `false` IS STILL NOT ALLOWED TO BE A GUESS, which is what stops the fix above from
   * collapsing into "read one page and answer".
   *
   * With no row in hand the question is genuinely unsettled, so a cursor this deployment cannot
   * follow means it does not know — and saying `false` there would delete the person's row and tell
   * a gate they may not act through an app they hold. The refusal is the honest answer, and it is
   * the one an early stop is most likely to take away by accident.
   */
  test("a cursor fault before any account has been seen is still a refusal", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async () => ({ items: [], nextCursor: 7 }),
        },
      }),
      () => 1_000_000,
    );

    const failure = await failureOf(
      broker.isConnected({ userId: "user_1", toolkit: "gmail" }),
    );
    expect(failure).toBeInstanceOf(BrokerRefusalError);
    expect(failure.message).not.toMatch(A_CRASH);
  });

  test("every page of this app's configs is read, so none is left standing", async () => {
    const asked: unknown[] = [];
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) => {
            asked.push(query);
            return (query as { cursor?: string }).cursor === undefined
              ? { items: [OURS], nextCursor: "page_2" }
              : { items: [OURS_SPARE], nextCursor: null };
          },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // The spare from a lost enable race is on page two. Left behind, it is a config the removal was
    // supposed to drop, holding every grant made against it, with the app's row deleted after this
    // returns and nothing left in this deployment pointing at it.
    expect(deleted).toEqual(["ac_ours", "ac_ours_spare"]);
    expect(asked).toEqual([
      { toolkit: "linear", limit: WHOLE_LISTING, showDisabled: true },
      {
        toolkit: "linear",
        limit: WHOLE_LISTING,
        showDisabled: true,
        cursor: "page_2",
      },
    ]);
  });

  test("a config of ours on a later page is the one a connection is begun against", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async (query: unknown) =>
            (query as { cursor?: string }).cursor === undefined
              ? { items: [BY_HAND], nextCursor: "page_2" }
              : { items: [OURS], nextCursor: null },
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    // Reading one page here answers "this deployment has no config for linear" and sends an
    // administrator to remove and re-add an app whose config is sitting on page two.
    expect(linked).toEqual([
      ["user_1", "ac_ours", { callbackUrl: RETURN_URL }],
    ]);
  });

  test("a cursor that is not a cursor is refused rather than read as the end of the list", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            return { items: [{ id: "ca_1" }], nextCursor: 42 };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Read as absent, a cursor this deployment cannot follow is a truncated page wearing the
    // clothes of a complete answer — which is the one thing this guard exists to make impossible.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(deleted).toEqual([]);

    /*
     * THE REFUSAL HAS TO BE THIS ONE AND NOT THE LOOP GUARD NEXT DOOR, which is what these two
     * assertions are for and what a mutation run proved they had to be. Coerce the unreadable
     * cursor to "" and the paging sends a SECOND request carrying it, gets the same page back, and
     * refuses — with a sentence saying Composio answered the same page twice, which is a complaint
     * about the vendor for something this deployment did. One request went out, and the sentence
     * names what arrived where a cursor belongs.
     */
    expect(calls).toBe(1);
    expect(refusal.message).toMatch(/where the cursor to the next page/);
  });

  /**
   * A CURSOR WITH NOTHING IN IT IS THE END OF THE LISTING, NOT A REFUSAL — AND THE VENDOR'S OWN
   * TYPES PERMIT IT.
   *
   * All four list responses in the installed client declare `next_cursor?: string | null`
   * (`@composio/client` 0.1.0-alpha.76, `resources/auth-configs.d.ts:248`,
   * `connected-accounts.d.ts:4987`, `toolkits.d.ts:326`, `tools.d.ts:204`), so `""` is type-legal
   * on the wire; both transformers write `response.next_cursor ?? null`, which does not catch it;
   * and it therefore reached the guard and became a hard refusal. What that refusal takes down is
   * not one call: `revoke`, `authorize`, `ensureAuthConfig`, `deleteAuthConfig` and `isConnected`
   * all read one of these two listings, so every app in the deployment stops working at once, for
   * as long as the vendor sends it — over a field whose whole content is that it has none.
   *
   * AND THERE IS NO SECOND REQUEST IT COULD HAVE MEANT. An empty cursor is exactly what this loop
   * sends when it has no position: the first request omits the field. Following it asks for page
   * one again, which is why the alternative reading ends in the loop guard next door accusing
   * Composio of answering the same page twice — a complaint about the vendor for something this
   * deployment did.
   *
   * THE ASSERTION IS ON WHAT WENT OUT AS WELL AS ON WHAT CAME BACK. An implementation that read the
   * empty cursor as the end and ALSO sent a second request would answer identically here without
   * the call count, and it is the second request that is the defect.
   */
  for (const { shape, cursor } of [
    { shape: "an empty string", cursor: "" },
    { shape: "a string of blank space", cursor: "   " },
  ]) {
    test(`a cursor Composio sent as ${shape} ends the listing rather than refusing it`, async () => {
      let calls = 0;
      const deleted: string[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: { list: ourGmailConfig },
          connectedAccounts: {
            list: async () => {
              calls += 1;
              return { items: [{ id: "ca_1" }], nextCursor: cursor };
            },
            delete: async (id: string) => {
              deleted.push(id);
              return WITHDRAWN;
            },
          },
        }),
      );

      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      expect(deleted).toEqual(["ca_1"]);
      expect(calls).toBe(1);
    });
  }

  /**
   * AND THE SAME ON THE CONFIG LISTING, WHICH IS THE HALF THIS FILE KEEPS FORGETTING.
   *
   * One cursor guard serves both listings, so a fix written against the accounts path is a fix
   * everywhere — and a test written only against the accounts path is a test that cannot tell the
   * difference. Removing an app reads this listing and nothing else, so an empty cursor refused
   * here is an app nobody can withdraw.
   */
  test("an empty cursor ends the config listing too, so the app can still be removed", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => {
            calls += 1;
            return { items: [OURS], nextCursor: "" };
          },
          delete: async (id: string) => {
            deleted.push(id);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    expect(deleted).toEqual(["ac_ours"]);
    expect(calls).toBe(1);
  });

  test("a cursor that never advances is refused rather than followed for ever", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            if (calls > 20) throw new Error("The paging did not terminate.");
            return { items: [{ id: "ca_1" }], nextCursor: "page_2" };
          },
          // The delete ANSWERS rather than refusing, which is what makes this test able to fail: a
          // reader that follows no cursor withdraws `ca_1`, reports a completed disconnection, and
          // would satisfy any assertion that only asked for a refusal of some kind.
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // A vendor answering the same cursor for ever is a hung request rather than a long one, and the
    // caller here is a person waiting on a page they pressed disconnect from.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(calls).toBeLessThanOrEqual(3);
    expect(deleted).toEqual([]);
  });

  test("a cursor that advances for ever is stopped at a ceiling, and stopping is a refusal", async () => {
    let calls = 0;
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => {
            calls += 1;
            // A cursor that is different every time defeats the same-page guard above, so this is
            // the one shape only the ceiling catches. The throw is the test's own stop: without a
            // ceiling in the adapter this listing has no end at all.
            if (calls > 200) throw new Error("The paging did not terminate.");
            // One row a page, so the row count in the refusal is a figure somebody counted rather
            // than the page size this deployment asked for.
            return {
              items: [{ id: `ca_${calls}` }],
              nextCursor: `page_${calls}`,
            };
          },
          delete: async (id: string) => {
            deleted.push(id);
            return WITHDRAWN;
          },
        },
      }),
    );

    const refusal = await failureOf(
      broker.revoke({ userId: "user_1", toolkit: "gmail" }),
    );

    // Stopping is the easy half; the half that matters is that stopping is not answering. A ceiling
    // that returned the rows it had would be the page ceiling again, further out and harder to see.
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(deleted).toEqual([]);

    // The number of pages that happened, and the number the sentence states, are the same number.
    expect(calls).toBe(PAGES_BEFORE_REFUSING);
    expect(refusal.message).toMatch(
      new RegExp(`answered ${PAGES_BEFORE_REFUSING} pages`),
    );

    // And the sentence asserts no page size nobody measured. `at 1000 rows each` was the limit this
    // deployment ASKED for, stated as a fact about what Composio sent — these pages carry one row.
    expect(refusal.message).not.toMatch(new RegExp(`${WHOLE_LISTING} rows`));
    expect(refusal.message).toMatch(
      new RegExp(`${PAGES_BEFORE_REFUSING} rows in all`),
    );
  });
});

/**
 * The two vendor answers that are single objects, and what is actually in doubt about each.
 *
 * THE CONTAINER IS NOT, WHICH IS A CORRECTION TO WHAT THESE USED TO ASSERT. Both answers were once
 * fed a bare `null` on the argument that a single object read straight off an `await` has a declared
 * type that only looks settled. Running `@composio/core` 0.18.1 settles it for real, on both paths
 * and for different reasons: `getRawComposioToolBySlug` ends in a throwing `ToolSchema.parse`
 * (`src/models/Tools.ts:719`), and `connectedAccounts.link` builds its answer with
 * `createConnectionRequest(...)` inside a try that turns everything else into
 * `ComposioFailedToCreateConnectedAccountLink` (`src/models/ConnectedAccounts.ts:420-453`). So
 * neither can hand over something that is not an object, and the refusals that stood for that were
 * branches no answer could reach.
 *
 * WHAT IS IN DOUBT IS EACH ONE'S ONE COPIED FIELD. The tool's `toolkit.slug` is a required string
 * that `z.string()` lets be empty, and the request's `redirectUrl` is `response.redirect_url`
 * carried across untouched by a builder that validates nothing. Those are what these tests are
 * about now, and both are shapes Composio can actually send.
 */
describe("a vendor answer that is one object rather than a listing", () => {
  /** The call `execute` is made with in this section, which is a mismatch test's whole setup. */
  const GMAIL_CALL = {
    slug: "GMAIL_FETCH_EMAILS",
    toolkit: "gmail",
    userId: "user_1",
    version: "20260903_00",
  };

  /**
   * A RESOLVE THAT FAILED IS A CALL THAT MUST NOT RUN, WHICH IS THE HALF WORTH KEEPING.
   *
   * This test used to hand the resolve a bare `null` and assert that reading a field off it was
   * refused rather than crashed. `@composio/core` 0.18.1 cannot answer that: `getRawComposioToolBySlug`
   * ends in `transformToolCases`, whose last act is a throwing `ToolSchema.parse`
   * (`src/models/Tools.ts:719`, `:193`), so a null answer raises `TypeError: null is not an object
   * (evaluating 'tool.input_parameters')` and anything else that is not a tool raises a `ZodError` —
   * neither of which reaches a reader in the adapter. The guard it covered is gone; the property
   * underneath it is not, and this is that property asked of an input the vendor can actually
   * produce.
   */
  test("a resolve the SDK could not read refuses, and nothing is run", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => {
            throw new TypeError(
              "null is not an object (evaluating 'tool.input_parameters')",
            );
          },
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {} };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.execute(GMAIL_CALL, {}));

    // `./composio` puts whatever comes out of here into a model's context and an audit row, so the
    // crash is carried rather than quoted and the sentence names the one act that changes anything.
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/GMAIL_FETCH_EMAILS/);
    expect(refusal.message).toMatch(/@composio\/core/);
    expect(ran).toEqual([]);
  });

  test("an app the vendor named with nothing is not reported as no app at all", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            // The one toolkit fault a passing `ToolSchema.parse` still admits: `ToolkitSchema`
            // spells the slug required and `z.string()` is satisfied by the empty string. A bare
            // string where `{ slug }` belongs — what this fixture used to be — raises a `ZodError`
            // inside the SDK and never arrives.
            toolkit: { slug: "", name: "Gmail" },
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {} };
          },
        },
      }),
    );

    const refusal = await failureOf(actions.execute(GMAIL_CALL, {}));

    /*
     * THE TWO FACTS ARE NOT THE SAME AND THEIR REMEDIES ARE NOT EITHER. "Composio resolves that
     * action to no app at all" is a statement about the action, and the sentence carrying it tells
     * an administrator to refresh the app's tools — right for a slug recorded against a url that
     * has since changed, and useless for an SDK that has begun answering a different shape. The
     * toolkit here is PRESENT and its name is blank, which is neither of those.
     */
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).not.toMatch(/no app at all/);
    expect(ran).toEqual([]);
  });

  test("a redirect that is not a url is refused rather than handed to a browser", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: async () => ({ items: [OURS] }) },
        connectedAccounts: {
          link: async () => ({
            redirectUrl: { href: "https://backend.composio.dev/s/a-link" },
          }),
        },
      }),
    );

    /*
     * PRESENT, TRUTHY AND NOT A URL, which is the one shape the `if (!redirectUrl)` guard beside it
     * cannot see. What is on the other side of that return is a `Location` header and a person's
     * browser, so `[object Object]` would be a page nobody can visit, reported as the consent
     * screen they were sent to.
     */
    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
  });
});

/**
 * The field guards, held to the behaviour each was written for.
 *
 * EVERY TEST HERE COVERS A GUARD THAT WAS ALREADY IN THE FILE AND HAD NOTHING HOLDING IT. That is
 * worse than an untested new behaviour rather than better: a guard nothing reddens for is read by
 * the next person as ceremony over a field the SDK's own types already promise, and deleting it
 * leaves a green suite. Each one below was therefore checked by removing the guard it covers and
 * watching this test fail.
 */
describe("what a malformed field of a row actually costs", () => {
  const CATALOGUE_ROWS: { fault: string; row: unknown; names: RegExp }[] = [
    {
      fault: "a slug that arrived as null",
      // The slug is the only name this deployment has for an app: it is what enabling one writes
      // into a url and what every later call names, so a row without one is an app whose Add button
      // records something nothing can act on. Deleting this guard left the suite green.
      row: { slug: null, name: "Gmail", meta: {} },
      names: /slug/,
    },
    {
      fault: "a logo that is not an address",
      // This value is put in an image address on an administrator's picker. Deleting this guard
      // also left the suite green: the object went into `src` and the page showed a broken image.
      row: {
        slug: "gmail",
        name: "Gmail",
        meta: { logo: { url: "https://example.test/gmail.png" } },
      },
      names: /logo/,
    },
    {
      fault: "a name that arrived as null",
      // `?? ""` here is an app in an administrator's picker with nothing written on it, and `gmail`
      // is a slug rather than a title.
      row: { slug: "gmail", name: null, meta: {} },
      names: /name/,
    },
    {
      fault: "a description that is not text",
      row: { slug: "gmail", name: "Gmail", meta: { description: 12 } },
      names: /description/,
    },
    {
      fault: "a category with no name",
      // The categories are the words a person chooses an app by, so a blank one is a filter nobody
      // can use rather than a cosmetic gap.
      row: {
        slug: "gmail",
        name: "Gmail",
        meta: { categories: [{ slug: "productivity" }] },
      },
      names: /categor/,
    },
    {
      fault: "an action count that arrived as a string",
      // `Number("63")` is the defect this whole sweep is about: a vendor change turned into a
      // plausible figure, shown BEFORE anybody enables an app, that nobody would think to question.
      row: { slug: "gmail", name: "Gmail", meta: { toolsCount: "63" } },
      names: /count/,
    },
  ];

  for (const { fault, row, names } of CATALOGUE_ROWS) {
    test(`a catalogue row with ${fault} stops the directory`, async () => {
      const { broker } = buildComposioClient(
        fakeVendor({ toolkits: { get: async () => [row] } }),
        () => 1_000_000,
      );

      const refusal = await failureOf(broker.listApps());

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(names);
    });
  }

  /**
   * THE ACTION ROW HAS ONE FAULT LEFT, AND FOUR TESTS HERE WERE ABOUT SHAPES IT CANNOT HAVE.
   *
   * A description that is not text, an `inputParameters` that is a string of JSON, tags that are
   * not all labels and a version that is a number each had a row in a table beside this one, and
   * each was answered by a refusal in the adapter. Running `@composio/core` 0.18.1 shows all four
   * dying one layer earlier: `transformToolCases` ends in `ToolSchema.parse(...)` — a throwing
   * parse, not the warn-only `transform()` the other three listings go through
   * (`src/models/Tools.ts:193`) — and both calls this adapter makes run through it (`:561`, `:719`).
   * Every one of those four fixtures produces a `ZodError` from inside the SDK, which `./composio`'s
   * `isSchemaMismatch` already recognises and answers with the same package remedy. So the tests
   * were green over guards nothing could reach, which is the worst of the three states: a reader
   * takes both the guard and the test as proof the path is watched.
   *
   * WHAT `ToolSchema` LEAVES OPEN IS THE ONE BELOW. `slug: z.string()` is satisfied by the empty
   * string, and this slug is not a label: it becomes `mcp_tools.name`, which is NOT NULL and half
   * that table's primary key, it is what a grant points at, and it is what a later call sends back
   * to Composio. That is the fault this listing still has to refuse, and it is the only one.
   */
  test("an action whose slug is blank stops the listing rather than being written", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioTools: async () => [
            { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails" },
            { slug: "   ", name: "Send mail" },
          ],
        },
      }),
    );

    const refusal = await failureOf(
      actions.listActions("gmail", { limit: WHOLE_LISTING }),
    );

    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/slug/);
    // Which row, because an administrator reading this off a Plugins page has a listing of sixty
    // actions and no other way to tell which of them Composio named with nothing.
    expect(refusal.message).toMatch(/row 2/);
    // And what it cost them, which is nothing: a refusal here leaves the actions already recorded
    // for the app in place rather than replacing them with a listing one row short.
    expect(refusal.message).toMatch(/tools already held are untouched/);
  });

  /**
   * A CATEGORY THAT IS NOT A CATEGORY IS DESCRIBED AS WHAT ARRIVED, NOT AS A MISSING NAME.
   *
   * The non-object guard here was deleted on the stated ground that the SDK dereferences a category
   * and dies before this file sees one. Running `@composio/core` 0.18.1 says otherwise: `("crm").id`
   * is `undefined` and not a throw, so a string, a number or a boolean in that list survives
   * `transformToolkitListResponse` — only null and undefined die there. What the refusal then said
   * was "Composio sent nothing where the name of gmail's category 1 belongs", about a value that
   * was the string "crm", which sends an operator looking in a dashboard for a category with a
   * missing name. There is no such category.
   *
   * THE ASSERTION IS ON THE TWO SENTENCES BEING DIFFERENT, because a test that only required a
   * refusal was green over the whole defect: the catalogue was refused either way, and what was
   * wrong was what the operator was told.
   */
  for (const { fault, entry, names } of [
    { fault: "a string", entry: "crm", names: /a string/ },
    { fault: "a number", entry: 7, names: /a number/ },
  ]) {
    test(`a category that arrived as ${fault} is named as one rather than as a missing name`, async () => {
      const { broker } = buildComposioClient(
        fakeVendor({
          toolkits: {
            get: async () => [
              { slug: "gmail", name: "Gmail", meta: { categories: [entry] } },
            ],
          },
        }),
        () => 1_000_000,
      );

      const refusal = await failureOf(broker.listApps());

      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(A_CRASH);
      expect(refusal.message).toMatch(/gmail's category 1/);
      expect(refusal.message).toMatch(names);
      // And NOT the sentence for a category object whose name Composio omitted, which is the other
      // fault and the other thing to go looking at.
      expect(refusal.message).not.toMatch(/Composio sent nothing/);
    });
  }

  /**
   * A BLANK IDENTIFIER IS DESCRIBED AS BLANK RATHER THAN AS "A STRING".
   *
   * {@link textOf} decides emptiness on the TRIMMED value and `sent` tested `value === ""`, so the
   * two disagreed about exactly one shape — the padded blank, which is the one a wire value
   * actually arrives in. A config id of three spaces was refused for being empty and then described
   * as "a string", which is a sentence with no finding in it: a string is what an id IS, so the
   * reader is told the field was right and the call refused anyway.
   */
  test("a config id that is nothing but spaces is not reported as a string", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "   ", name: "Linear (OpenBot)", status: "ENABLED" }],
          }),
        },
      }),
    );

    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect((refusal.cause as Error).message).toMatch(/blank space/);
    expect((refusal.cause as Error).message).not.toMatch(
      /Composio sent a string where/,
    );
  });

  /**
   * THE THREE ACTION FIELDS THIS FILE HANDS ON, AND WHAT EACH BECOMES WHERE IT LANDS.
   *
   * The four deleted guards next door were deleted correctly — `ToolSchema.parse` really does raise
   * a `ZodError` for them — and the argument was then taken one step too far, past the fields
   * {@link ComposioAction} promises to `./composio` and `./store`. The parse is a fact about
   * `getRawComposioTools` in one version of one package; the declaration is what the seam a test
   * satisfies with a literal, and what the next version is read against, actually rest on.
   *
   * WHAT THAT COSTS IS NOT A REFUSAL, WHICH IS WHY IT BELONGS HERE. `storableTools` writes
   * `(tool.description ?? "").replaceAll(NUL, "")` and `tool.version?.replaceAll(NUL, "")`, so a
   * description or a version that is not a string is a bare "42.replaceAll is not a function"
   * thrown from outside every vendor `try` in the adapter — a crash where this file's whole
   * contract is a sentence. An `inputParameters` that is not an object is quieter: it is stored as
   * the action's input schema and shown to a model as Composio's own.
   *
   * EACH ASSERTS THE FIELD IT IS ABOUT, because a table of refusals that only required a refusal
   * would pass with one guard standing in for three.
   */
  for (const { fault, row, names } of [
    {
      fault: "a description that is not text",
      row: { slug: "GMAIL_FETCH_EMAILS", description: 42 },
      names: /description/,
    },
    {
      fault: "an input schema that is not an object",
      row: { slug: "GMAIL_FETCH_EMAILS", inputParameters: "not-a-schema" },
      names: /input schema/,
    },
    {
      fault: "a version that is not text",
      row: { slug: "GMAIL_FETCH_EMAILS", version: 20_260_903 },
      names: /version/,
    },
  ]) {
    test(`an action with ${fault} stops the listing rather than crossing the seam`, async () => {
      const { actions } = buildComposioClient(
        fakeVendor({ tools: { getRawComposioTools: async () => [row] } }),
      );

      const failure = await failureOf(
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
      );

      expect(failure.message).not.toMatch(A_CRASH);
      expect(failure.message).toMatch(names);
      // The tools already recorded for the app are untouched, which is what makes refusing the
      // right answer rather than a worse outage than the one being avoided.
      expect(failure.message).toMatch(/tools already held are untouched/);
    });
  }

  /**
   * AND AN ACTION THAT PUBLISHES NONE OF THEM IS ORDINARY. Composio genuinely ships actions with no
   * description and no version, and one with no parameters at all arrives with none — the SDK
   * normalizes `{}` to absent before parsing. Absence is a fact about the action; present-and-wrong
   * is a fact about the answer. A guard that could not tell them apart would refuse most of the
   * catalogue.
   */
  test("an action that publishes no description, schema or version is still listed", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioTools: async () => [{ slug: "GMAIL_FETCH_EMAILS" }],
        },
      }),
    );

    expect(
      await actions.listActions("gmail", { limit: WHOLE_LISTING }),
    ).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: undefined,
        inputParameters: undefined,
        tags: undefined,
        version: undefined,
      },
    ]);
  });

  test("a nameless config stops the removal rather than being left standing", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [OURS, { id: "ac_nameless", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * WITHOUT THE GUARD THIS IS A REPORTED SUCCESS. A name read as "" fails the suffix test, so the
     * row is sorted into somebody else's dashboard work and left standing — and `deleteAuthConfig`
     * returns quietly, after which `removeServer` deletes the app's row. The config and every grant
     * made against it outlive the removal with nothing in this deployment naming them.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/name/);
    /*
     * AND THE CONFIG THAT WAS READABLE IS GONE, WHICH THIS ASSERTED THE OPPOSITE OF ON PURPOSE AND
     * IS CHANGED ON PURPOSE. It required `[]` — not even the row that WAS readable — on the ground
     * that a half-done removal reported as done is the state being avoided. The first half of that
     * is right and the second half does not describe this: the call still refuses, so `removeServer`
     * never deletes the app's row and nothing is reported as done. What the old shape actually
     * bought was a permanent block. The unreadable row is unreadable on every retry, so the app
     * could never be removed at all while a config of ours held live grants the whole time — which
     * is the defect the accounts path was corrected for one wave earlier, sitting one function
     * away. Every config this deployment CAN name goes, and the row it cannot is what the refusal
     * counts.
     */
    expect(deleted).toEqual([["ac_ours", { revoke_on_delete: true }]]);
    // And the remedy for the row that is left is the dashboard rather than the button just pressed,
    // because the next press meets exactly the same unreadable row.
    expect(refusal.message).toMatch(/Composio's own dashboard/);
  });

  test("a config with no id stops the removal, and no delete is sent", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ name: "Linear (OpenBot)", status: "ENABLED" }],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    /*
     * A DELETE WITHOUT AN ID IS A REQUEST COMPOSIO IS FREE TO READ AS ANYTHING, answered however it
     * likes, after which this deployment records that the app was withdrawn. The assertion is on
     * what went out rather than on what came back for exactly that reason.
     */
    const refusal = await failureOf(broker.deleteAuthConfig("linear"));
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).toMatch(/id/);
    expect(deleted).toEqual([]);
  });

  test("an unreadable status names every config's own, not the first one's for all of them", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "PENDING" },
              { id: "ac_b", name: "Linear (OpenBot)", status: "SUSPENDED" },
            ],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    /*
     * TWO CONFIGS, TWO STATUSES, AND THE SENTENCE COUNTED BOTH AND QUOTED ONE — asserting of the
     * pair a fact it had established of the first. The status is quoted because it is the one
     * thing an operator can search a dashboard and a changelog for, and an operator given PENDING
     * would never find the config that says SUSPENDED.
     */
    expect(refusal.message).toMatch(/"PENDING"/);
    expect(refusal.message).toMatch(/"SUSPENDED"/);
    expect(refusal.message).toMatch(/2 of this deployment's 2/);
  });

  test("a status that is not a vendor enum name is described rather than repeated", async () => {
    /*
     * THIS BRANCH IS REACHED PRECISELY BECAUSE THE VALUE IS NOT ONE OF THE WORDS THE CODE EXPECTS,
     * so "it is a closed set of enum names" — the whole argument for quoting it — is the one thing
     * that cannot be assumed here. What arrives is whatever came off the wire, and the refusal it
     * lands in is read off an admin page, written into an app's `lastError` and put in front of a
     * model.
     */
    const WIRE = `<!doctype html>\n<title>502 Bad Gateway</title>\n${"x".repeat(20_000)}`;
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [{ id: "ac_a", name: "Linear (OpenBot)", status: WIRE }],
          }),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.authorize({
        userId: "user_1",
        toolkit: "linear",
        returnUrl: RETURN_URL,
      }),
    );

    expect(refusal.message).not.toContain("502 Bad Gateway");
    expect(refusal.message).not.toContain("x".repeat(64));
    expect(refusal.message.length).toBeLessThan(1000);
    // Still a refusal, and still one naming the state: what the value IS remains the finding even
    // where the value itself is not safe to repeat.
    expect(refusal.message).toMatch(/neither ENABLED nor DISABLED/);
    expect(refusal.message).toMatch(/a string/);
  });

  test("the config a connection is begun against is chosen in one order everywhere", async () => {
    const linked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: "ac_a", name: "Linear (OpenBot)", status: "ENABLED" },
              { id: "ac_B", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
        },
        connectedAccounts: {
          link: async (...call: unknown[]) => {
            linked.push(call);
            return { redirectUrl: "https://backend.composio.dev/s/a-link" };
          },
        },
      }),
      () => 1_000_000,
    );

    await broker.authorize({
      userId: "user_1",
      toolkit: "linear",
      returnUrl: RETURN_URL,
    });

    /*
     * `ac_B` BECAUSE "B" IS 0x42 AND "a" IS 0x61, which is the same answer on every machine. Under
     * `localeCompare` with no locale it is the HOST that decides — an English collation puts
     * `ac_a` first — and the two callers this order exists to keep in step are a person pressing
     * Connect and an administrator pressing Remove, who need not be answered by the same process,
     * container or build of ICU. This pair is the one that tells the two orders apart.
     */
    expect(linked).toEqual([["user_1", "ac_B", { callbackUrl: RETURN_URL }]]);
  });

  test("a created config the answer does not name is reported as possibly standing", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          // The create was accepted; what came back carries no id. The answer used to be awaited
          // and dropped, so this was a successful enable of an app whose config nothing here could
          // show existed.
          create: async () => ({}),
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" }),
    );

    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(A_CRASH);
    expect(refusal.message).toMatch(/may well be standing/);
    expect(refusal.message).toMatch(/enabling linear again finds it/);
  });

  test("a create whose reply the SDK could not read does not claim nothing was created", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [] }),
          /*
           * What `transformCreateAuthConfigResponse` does to an answer with no `auth_config`: it
           * reads `response.auth_config.id` (`@composio/core` 0.18.1,
           * `src/utils/transformers/authConfigs.ts:96-106`) and raises inside the vendor's own
           * package — AFTER the create has been sent and answered.
           */
          create: async (): Promise<never> => {
            throw new TypeError(
              "undefined is not an object (evaluating 'response.auth_config.id')",
            );
          },
        },
      }),
      () => 1_000_000,
    );

    const refusal = await failureOf(
      broker.ensureAuthConfig({ toolkit: "linear", name: "Linear" }),
    );

    /*
     * THE ONE CONDITION MOST LIKELY TO MEAN THE CONFIG EXISTS WAS THE ONE SAYING IT DID NOT. The
     * `TypeError` row translates a fault raised inside `@composio/core` while it READ a reply, so
     * by the time this sentence is composed the request has gone out and Composio has answered it
     * — and the outcome clause read "no authorization config was created for linear".
     */
    expect(refusal).toBeInstanceOf(BrokerRefusalError);
    expect(refusal.message).not.toMatch(/no authorization config was created/);
    expect(refusal.message).toMatch(
      /whether an authorization config for linear now stands at Composio is not something this deployment can tell/,
    );
  });

  const UNSETTLED: { fault: string; status: unknown }[] = [
    { fault: "a status this deployment has never heard of", status: "PENDING" },
    { fault: "no status at all", status: undefined },
  ];

  for (const { fault, status } of UNSETTLED) {
    test(`a config of ours with ${fault} refuses in its own words`, async () => {
      const linked: unknown[] = [];
      const { broker } = buildComposioClient(
        fakeVendor({
          authConfigs: {
            list: async () => ({
              items: [{ id: "ac_ours", name: "Linear (OpenBot)", status }],
            }),
          },
          connectedAccounts: {
            link: async (...call: unknown[]) => {
              linked.push(call);
              return { redirectUrl: "https://backend.composio.dev/s/a-link" };
            },
          },
        }),
      );

      const refusal = await failureOf(
        broker.authorize({
          userId: "user_1",
          toolkit: "linear",
          returnUrl: RETURN_URL,
        }),
      );

      /*
       * NEITHER OF THE OTHER TWO REMEDIES, which is the whole of what this asserts. Telling an
       * operator the config is disabled sends them to a dashboard to enable something that may
       * already be enabled, and leaves them with a page insisting on a fact they can see is false;
       * telling them there is no config sends them to remove and re-add an app whose config is
       * sitting right there. The state is UNKNOWN, and only a sentence saying so is honest.
       */
      expect(refusal).toBeInstanceOf(BrokerRefusalError);
      expect(refusal.message).not.toMatch(DISABLED_REMEDY);
      expect(refusal.message).not.toMatch(NO_CONFIG_REMEDY);
      // And still a refusal: consent spent against a config this deployment cannot show is enabled
      // attaches nothing, and cannot be spent again without sending the person round a second time.
      expect(linked).toEqual([]);
    });
  }
});

/**
 * WHAT A FIELD COMPOSIO PADDED IS WORTH, WHICH IS THE FIELD AND NOT THE FIELD PLUS ITS PADDING.
 *
 * `textOf` decided emptiness on the TRIMMED string and answered the PADDED one — a guard that
 * checked one value and passed along another — so every identifier this adapter reads travelled
 * with whatever whitespace the wire wrapped it in. Not one of the four below is cosmetic: three of
 * them are what a later REQUEST names, and the fourth is both sides of the one comparison this
 * file refuses a call on.
 *
 * WHY A VENDOR WOULD SEND ONE AT ALL is the same reason `madeHere` tolerates a trailing space in a
 * config's name: these values pass through dashboards where people type, paste and edit them.
 */
describe("a field Composio padded with whitespace", () => {
  test("a padded slug and title reach the picker as the app's own name", async () => {
    const { broker } = buildComposioClient(
      fakeVendor({
        toolkits: {
          get: async () => [
            { slug: "  gmail  ", name: " Gmail ", meta: { toolsCount: 63 } },
          ],
        },
      }),
      () => 1_000_000,
    );

    const [app] = await broker.listApps();

    /*
     * THE SLUG IS THE ONE THAT COSTS SOMETHING. `addBrokeredApp` composes `composio://<slug>` from
     * exactly this value, and `toolkitOf` reads the app back out of that url through a character
     * class that admits no spaces — so a padded slug here is an enabled app whose url names no app
     * at all, and every later call through it refuses.
     */
    expect(app?.slug).toBe("gmail");
    expect(app?.name).toBe("Gmail");
  });

  test("a padded config id is what the delete names, without the padding", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              { id: " ac_ours ", name: "Linear (OpenBot)", status: "ENABLED" },
            ],
          }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    await broker.deleteAuthConfig("linear");

    // The id is the whole of what a deletion names, and this one was sent verbatim: Composio is
    // asked to remove an object with a name nobody holds, and this deployment records a withdrawal.
    expect(deleted).toEqual([["ac_ours", { revoke_on_delete: true }]]);
  });

  test("a padded account id is what the withdrawal names", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: { list: ourGmailConfig },
        connectedAccounts: {
          list: async () => ({ items: [{ id: " ca_1 " }] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
            return WITHDRAWN;
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual([["ca_1", { revoke_on_delete: true }]]);
  });

  test("a padded action slug is recorded as the action rather than as one nothing can call", async () => {
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioTools: async () => [
            { slug: " GMAIL_FETCH_EMAILS ", version: "20260903_00" },
          ],
        },
      }),
    );

    const [action] = await actions.listActions("gmail", {
      limit: WHOLE_LISTING,
    });

    // This becomes `mcp_tools.name`, which is half that table's primary key, what a grant points at
    // and what the next call sends back to Composio.
    expect(action?.slug).toBe("GMAIL_FETCH_EMAILS");
  });

  test("a padded app slug on the vendor's answer is not a mismatch", async () => {
    const ran: unknown[] = [];
    const { actions } = buildComposioClient(
      fakeVendor({
        tools: {
          getRawComposioToolBySlug: async () => ({
            slug: "GMAIL_FETCH_EMAILS",
            toolkit: { slug: " gmail " },
          }),
          execute: async (...call: unknown[]) => {
            ran.push(call);
            return { successful: true, data: {}, error: null };
          },
        },
      }),
    );

    /*
     * THE MISMATCH REFUSAL IS THE ONE PLACE THIS FILE REFUSES TO RUN SOMETHING, and it exists for a
     * url edited between a refresh and a call. A padded slug is not that: it is the same app,
     * refused with a sentence naming a remedy — refresh this app's tools — that cannot change what
     * Composio pads.
     */
    await actions.execute(
      {
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_1",
        version: "20260903_00",
      },
      {},
    );

    expect(ran).toHaveLength(1);
  });
});

/**
 * WHICH `delete` THE VENDOR OBJECT ACTUALLY CARRIES, asserted without a network and without a key.
 *
 * THIS IS THE ONE DECISION IN {@link createComposioClient} AND NOTHING REACHED IT. That function is
 * described in its own comment as too thin to have a bug in, and it is — except for two lines.
 * `Composio`'s own `authConfigs.delete` and `connectedAccounts.delete` hard-code the request body
 * they send (`@composio/core` 0.18.1, `src/models/AuthConfigs.ts:303-311`,
 * `src/models/ConnectedAccounts.ts:532-540`), so through them `revoke_on_delete` cannot be passed at
 * all and every delete soft-deletes while the grant at Google or Slack stands. Both are therefore
 * satisfied from `composio.getClient()` instead, and that routing is the whole reason this
 * deployment's withdrawals withdraw anything.
 *
 * EVERY OTHER TEST IN THIS FILE DRIVES {@link buildComposioClient}, which takes the vendor object
 * already assembled — so the four that assert `revoke_on_delete` went out assert it about a double,
 * and none of them can see which function `createComposioClient` put behind it. Swapping those two
 * lines back to `composio.authConfigs.delete` and `composio.connectedAccounts.delete` type-checks
 * and leaves this suite green while restoring the exact defect the flag was added for. The only
 * thing that ever exercised the real wiring was `composio-live.test.ts`, which is skipped in every
 * run that has no key — which is every ordinary run.
 *
 * WHAT MAKES IT OBSERVABLE OFFLINE IS THAT BOTH CLIENTS ARE CONSTRUCTIBLE WITHOUT DIALLING
 * ANYTHING. `new Composio({ apiKey })` opens no socket once tracking and the npm version check are
 * off, `getClient()` hands back the underlying `@composio/client` it already holds, and the methods
 * of both live on their classes' prototypes. So a prototype replaced BEFORE `createComposioClient`
 * runs is what the client it builds will call: the SDK's telemetry wrapper copies each method off
 * the prototype at construction (`src/telemetry/Telemetry.ts:95-116`), and the raw client's
 * resources carry no own properties at all. Four recorders — one on each side of each delete — turn
 * "which function was reached" into a list, which is a fact about the wiring rather than about a
 * request that was never made.
 *
 * THE IMPORT OF `@composio/core` HERE DOES NOT BREAK THE ONE-IMPORT-SITE RULE. That rule is about
 * `server/src`, so that a version bump has exactly one FILE of product code to be read against;
 * this is a test, and the version it is written against is the whole of what it asserts.
 */
describe("the key becoming a vendor, and which delete that vendor carries", () => {
  /** One class's methods, as the object a replacement is written onto. */
  type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;

  const methodsOf = (instance: object): Methods =>
    Object.getPrototypeOf(instance) as Methods;

  test("both deletes are the raw client's, and neither is the SDK's own wrapper", async () => {
    /*
     * A SECOND CLIENT, BUILT ONLY TO REACH THE CLASSES. Nothing is called on it: it exists because
     * the prototypes are not exported, and the way to a prototype is an instance. The key is a
     * string nobody will ever send anywhere, which is the point of asserting this without one.
     */
    const seed = new Composio({
      apiKey: "never-dialled",
      allowTracking: false,
      disableVersionCheck: true,
    });
    const sdkAccounts = methodsOf(seed.connectedAccounts);
    const sdkConfigs = methodsOf(seed.authConfigs);
    const rawAccounts = methodsOf(seed.getClient().connectedAccounts);
    const rawConfigs = methodsOf(seed.getClient().authConfigs);

    const restore: { on: Methods; name: string; was: Methods[string] }[] = [];
    const replace = (on: Methods, name: string, answer: Methods[string]) => {
      restore.push({ on, name, was: on[name] });
      on[name] = answer;
    };

    const reached: string[] = [];
    const recorder =
      (whose: string): Methods[string] =>
      async (...call: unknown[]) => {
        reached.push(`${whose} ${JSON.stringify(call)}`);
        return { success: true };
      };

    try {
      /*
       * BOTH SIDES OF BOTH DELETES ARE RECORDED, which is what makes the list an assertion rather
       * than a spy. A recorder on the raw client alone would still fire if the SDK's wrapper were
       * used, because the wrapper calls straight through to it — so what tells the two wirings
       * apart is whose recorder answered, and the only way to see that is to have one on each.
       */
      replace(
        rawAccounts,
        "delete",
        recorder("the raw client's connectedAccounts.delete"),
      );
      replace(
        sdkAccounts,
        "delete",
        recorder("the SDK's own connectedAccounts.delete"),
      );
      replace(
        rawConfigs,
        "delete",
        recorder("the raw client's authConfigs.delete"),
      );
      replace(
        sdkConfigs,
        "delete",
        recorder("the SDK's own authConfigs.delete"),
      );

      // The two listings that carry each delete to its argument. Answered from memory, so this test
      // reaches the network exactly as often as it reaches the live Composio account: never.
      replace(sdkAccounts, "list", async () => ({
        items: [{ id: "ca_1" }],
        nextCursor: null,
      }));
      replace(sdkConfigs, "list", async () => ({
        items: [OUR_GMAIL],
        nextCursor: null,
      }));

      const { broker } = createComposioClient("never-dialled");
      expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
        true,
      );
      await broker.deleteAuthConfig("gmail");
    } finally {
      // Restored whatever happened above, because these are the SDK's own classes and every later
      // test in this process would otherwise be running against a patched vendor.
      for (const { on, name, was } of restore.reverse()) on[name] = was;
    }

    /*
     * THE WHOLE OF WHAT WAS REACHED, IN ORDER. An implementation that routed either delete through
     * the SDK's wrapper puts that wrapper's name in this list, and the equality says so; one that
     * dropped the flag puts a different argument list in it. Both are the same defect seen from
     * two sides, and neither is visible to any other test in this file.
     */
    expect(reached).toEqual([
      `the raw client's connectedAccounts.delete ["ca_1",{"revoke_on_delete":true}]`,
      `the raw client's authConfigs.delete ["${OUR_GMAIL.id}",{"revoke_on_delete":true}]`,
    ]);
  });
});
