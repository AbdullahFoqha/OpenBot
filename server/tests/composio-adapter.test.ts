import { describe, expect, test } from "bun:test";
import { BrokerRefusalError, brokerSentence } from "../src/plugins/broker";
import { LISTING_LIMIT } from "../src/plugins/composio";
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
      limit: LISTING_LIMIT,
    });

    // An omitted limit is not "no opinion": Composio's page defaults to 20, and
    // `getRawComposioTools` additionally sets `important=true` whenever a toolkit query carried no
    // limit, no tags and no search (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), so the
    // short answer is also a filtered one and nothing in it says so. Passing the limit through is
    // what turns that flag off, which is why the assertion is on the query and not on the answer.
    expect(asked).toEqual([{ toolkits: ["gmail"], limit: LISTING_LIMIT }]);
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
    expect(asked).toEqual([{ limit: LISTING_LIMIT, sortBy: "usage" }]);
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
    await expect(refused).rejects.toThrow(/slack/);
    await expect(refused).rejects.toThrow(/gmail/);
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
      { toolkit: "linear", limit: LISTING_LIMIT, showDisabled: true },
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

    await expect(refused).rejects.toThrow(/linear/);
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
  /** What a listing of one app's configs looks like when an operator has been in the dashboard. */
  const MIXED = [
    { id: "ac_by_hand", name: "Linear", status: "ENABLED" },
    { id: "ac_ours", name: "Linear (OpenBot)", status: "ENABLED" },
  ];

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
          list: async () => ({ items: [MIXED[0]] }),
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

    await expect(refused).rejects.toThrow(/linear/);
    expect(linked).toEqual([]);
  });

  test("removing an app drops every config of ours and leaves the hand-made one standing", async () => {
    const deleted: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({
            items: [
              ...MIXED,
              // The spare from a lost enable race: two administrators both found nothing and both
              // created. Both are ours, so both go — leaving one behind would leave live grants.
              {
                id: "ac_ours_spare",
                name: "Linear (OpenBot)",
                status: "ENABLED",
              },
            ],
          }),
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
    // nothing, and nothing on the page they are on can fix it.
    await expect(refused).rejects.toThrow(/disabled/);
    expect(linked).toEqual([]);
  });

  test("an app with only somebody else's config still gets one of our own", async () => {
    const created: unknown[] = [];
    const { broker } = buildComposioClient(
      fakeVendor({
        authConfigs: {
          list: async () => ({ items: [MIXED[0]] }),
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
        limit: LISTING_LIMIT,
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
        limit: LISTING_LIMIT,
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

    expect(brokerSentence(error)).toMatch(/An administrator/);
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

    expect(brokerSentence(error)).toMatch(/no page to visit/);
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
            return Array.from({ length: LISTING_LIMIT }, (_, index) => ({
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
