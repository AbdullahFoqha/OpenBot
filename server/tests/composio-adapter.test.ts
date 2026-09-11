import { describe, expect, test } from "bun:test";
import {
  type ComposioBroker,
  BrokerRefusalError,
  brokerSentence,
} from "../src/plugins/broker";
import {
  type ComposioActions,
  LISTING_LIMIT,
  vendorSentence,
} from "../src/plugins/composio";
import { buildComposioClient } from "../src/plugins/composio-adapter";

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

/** The page this deployment sends somebody back to once the consent screen is done with them. */
const RETURN_URL = "https://openbot.test/settings/connected-accounts/x";

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
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  const raised = await work.then(
    () => null,
    (error: unknown) => error,
  );
  if (raised === null) {
    throw new Error(
      "The call answered where this test requires it to have refused.",
    );
  }
  return raised as Error;
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
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }] }),
          delete: async (...call: unknown[]) => {
            deleted.push(call);
          },
        },
      }),
    );

    expect(await broker.revoke({ userId: "user_1", toolkit: "gmail" })).toBe(
      true,
    );
    expect(deleted).toEqual([["ca_1", { revoke_on_delete: true }]]);
  });

  test("the listing asks about every state a grant can be hiding in", async () => {
    const asked: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
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

  test("a refusal partway through still asks about the accounts behind it", async () => {
    const deleted: string[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        connectedAccounts: {
          list: async () => ({
            items: [{ id: "ca_1" }, { id: "ca_2" }, { id: "ca_3" }],
          }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
            deleted.push(id);
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
        connectedAccounts: {
          list: async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }),
          delete: async (id: string) => {
            if (id === "ca_2") throw new Error("Composio refused that one.");
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
   */
  const THROWN = [
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
    {
      method: "listActions",
      kind: "an outage",
      because:
        "The action listing did not answer. `./composio`'s own `listingSentence` names the app in what it records, so what is missing here is the vendor's reason and not the subject.",
    },
    {
      method: "execute",
      kind: "an outage",
      because:
        "The call itself failed with nothing said. `callTool` already refuses to pass the vendor's placeholder on and names the app instead.",
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
        const client = buildComposioClient(
          fakeVendor(
            seamCase.vendor(async () => {
              throw thrown.raise();
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
          return;
        }
        expect(sentence).not.toBeNull();
        expect(sentence?.trim()).not.toBe("");
      });
    }
  }
});

/**
 * WHAT EACH VENDOR LISTING IS ALLOWED TO BE, given that this file's types only assert its shape.
 *
 * A TYPESCRIPT INTERFACE OVER A WIRE VALUE IS AN ASSERTION AND NOT A CHECK, which is the whole
 * reason this table exists. `ComposioVendor` declares these four listings with required fields, and
 * the SDK that fills them in is warn-only: `@composio/core`'s own `transform()` logs a `safeParse`
 * failure and then returns the unvalidated object, so the shapes below are what actually arrives
 * rather than what could theoretically arrive. Each one has been observed reaching the adapter — a
 * toolkit with no name, an auth config whose name is null, a connected account with no id, a
 * category list containing null.
 *
 * WHAT A MALFORMED ANSWER MUST NOT BECOME IS A CRASH REPORT. `f.toLowerCase is not a function` and
 * `null is not an object` are what these produce today: the first as an unhandled 500 on a live
 * route, the rest as a 502 telling an administrator to check a key that is perfectly good. So each
 * case asserts that the call refuses, and that the refusal is a sentence rather than the name of a
 * method that was not there.
 *
 * ASSERTED AS A PROPERTY AND NOT AS A WORDING, because the fix does not exist yet and a test that
 * pinned the sentence would pin whichever one got written. What is required is that a reader be
 * told something, and that nothing be sent to the vendor on the strength of a field the answer did
 * not carry.
 */
describe("a vendor listing that is not the shape it is declared to be", () => {
  /** A recorder for what went out AFTER the malformed answer came back, which must be nothing. */
  type Probe = {
    parts: Parameters<typeof fakeVendor>[0];
    sent: unknown[];
  };

  const MALFORMED_LISTINGS: {
    listing: string;
    answers: { shape: string; answer: unknown }[];
    probe: (answer: unknown) => Probe;
    ask: (client: ReturnType<typeof buildComposioClient>) => Promise<unknown>;
    /** Whether the refusal has to be one a route passes through as this deployment's own. */
    authored: boolean;
  }[] = [
    {
      listing: "the app catalogue",
      answers: [
        { shape: "nothing at all", answer: null },
        {
          shape: "an envelope where a bare list belongs",
          answer: { items: [] },
        },
        { shape: "a row that is not an object", answer: ["gmail"] },
        {
          shape: "a row with no slug",
          answer: [{ name: "Gmail", meta: {} }],
        },
      ],
      probe: (answer) => ({
        parts: { toolkits: { get: async () => answer } },
        sent: [],
      }),
      ask: ({ broker }) => broker.listApps(),
      authored: true,
    },
    {
      listing: "this app's auth configs",
      answers: [
        { shape: "nothing at all", answer: null },
        { shape: "a bare list where an envelope belongs", answer: [] },
        {
          shape: "a row that is not an object",
          answer: { items: ["ac_ours"] },
        },
        {
          shape: "a row with no name",
          answer: { items: [{ id: "ac_ours", status: "ENABLED" }] },
        },
      ],
      probe: (answer) => {
        const sent: unknown[] = [];
        return {
          parts: {
            authConfigs: { list: async () => answer },
            connectedAccounts: {
              link: async (...call: unknown[]) => {
                sent.push(call);
                return { redirectUrl: "https://backend.composio.dev/s/a-link" };
              },
            },
          },
          sent,
        };
      },
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
        { shape: "nothing at all", answer: null },
        { shape: "a bare list where an envelope belongs", answer: [] },
        { shape: "a row that is not an object", answer: { items: ["ca_1"] } },
        { shape: "a row with no id", answer: { items: [{}] } },
      ],
      probe: (answer) => {
        const sent: unknown[] = [];
        return {
          parts: {
            connectedAccounts: {
              list: async () => answer,
              delete: async (...call: unknown[]) => {
                sent.push(call);
              },
            },
          },
          sent,
        };
      },
      ask: ({ broker }) =>
        broker.revoke({ userId: "user_1", toolkit: "gmail" }),
      authored: true,
    },
    {
      listing: "this app's actions",
      answers: [
        { shape: "nothing at all", answer: null },
        {
          shape: "an envelope where a bare list belongs",
          answer: { items: [] },
        },
        {
          shape: "a row that is not an object",
          answer: ["GMAIL_FETCH_EMAILS"],
        },
        {
          shape: "a row with no slug",
          answer: [{ description: "Fetch emails from Gmail." }],
        },
      ],
      probe: (answer) => ({
        parts: { tools: { getRawComposioTools: async () => answer } },
        sent: [],
      }),
      ask: ({ actions }) =>
        actions.listActions("gmail", { limit: WHOLE_LISTING }),
      // `./composio` authors this one's sentence, not `./broker`: a listing failure is recorded in
      // the app's `lastError` rather than answered to a route, so what is required here is a
      // sentence and not a class.
      authored: false,
    },
  ];

  /** What a failure must never read like: the name of a method that was not there. */
  const A_CRASH =
    /is not a function|is not an object|is not iterable|undefined is not|cannot read propert/i;

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
        // vendor is free to read as anything at all.
        expect(probe.sent).toEqual([]);
      });
    }
  }
});
