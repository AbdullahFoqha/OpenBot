import { expect, test } from "bun:test";
import { BrokerRefusalError } from "../src/plugins/broker";
import { connectionOf } from "../src/plugins/composio-adapter";

/**
 * Which flow an app gets, decided from what Composio's own catalogue publishes.
 *
 * Every case here is a real row measured against the live catalogue on 2026-09-13. The ordering
 * is the whole of the logic: `no_auth` wins outright because Composio REFUSES an auth config for
 * such a toolkit, managed OAuth beats everything else because it asks the person for nothing, and
 * a scheme this deployment cannot drive is named as unsupported rather than attempted.
 */
test("an app Composio holds credentials for gets the consent flow", () => {
  expect(
    connectionOf({
      slug: "gmail",
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "consent" });
});

test("managed OAuth wins over a key the app also accepts", () => {
  expect(
    connectionOf({
      slug: "linear",
      auth_schemes: ["OAUTH2", "API_KEY"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "consent" });
});

test("OAuth that registers itself needs nobody's credentials", () => {
  expect(
    connectionOf({
      slug: "linear_mcp",
      auth_schemes: ["DCR_OAUTH"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "self-registering" });
});

/**
 * A consent screen asks the person for nothing and a key asks them to go and find one, so an app
 * offering both should never send them looking.
 */
test("an app offering both a self-registering consent and a key prefers the consent", () => {
  expect(
    connectionOf({
      slug: "x",
      auth_schemes: ["DCR_OAUTH", "API_KEY"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "self-registering" });
});

test("an app the person holds a key for asks for fields", () => {
  expect(
    connectionOf({
      slug: "perplexityai",
      auth_schemes: ["API_KEY"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "fields", authScheme: "API_KEY" });
});

test("no_auth beats every scheme beside it, because Composio refuses a config for one", () => {
  expect(
    connectionOf({
      slug: "gemini",
      no_auth: true,
      auth_schemes: ["NO_AUTH", "API_KEY"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "no-auth" });
});

/**
 * Two of the thirty-four no-auth apps publish a managed scheme beside the flag, and they are the
 * only rows this precedence decides. Read as managed, they get a config Composio refuses outright.
 */
test("no_auth beats managed OAuth, because a config for one is refused however it is asked for", () => {
  expect(
    connectionOf({
      slug: "hackernews",
      no_auth: true,
      auth_schemes: ["NO_AUTH", "OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "no-auth" });
});

test("an app wanting this deployment's own OAuth client is unsupported, and says so", () => {
  const connection = connectionOf({
    slug: "docusign",
    auth_schemes: ["OAUTH2"],
    composio_managed_auth_schemes: [],
  });
  expect(connection.kind).toBe("unsupported");
  expect(connection.kind === "unsupported" && connection.reason).toContain(
    "its own OAuth client",
  );
});

test("an app publishing nothing readable is unsupported rather than guessed at", () => {
  expect(connectionOf({ slug: "mystery" }).kind).toBe("unsupported");
});

/**
 * "PUBLISHES NOTHING" AND "PUBLISHES SOMETHING THIS DEPLOYMENT CANNOT READ" ARE TWO ANSWERS.
 *
 * The case above is the first of them and is real: Composio genuinely lists toolkits with no
 * scheme beside them, and unsupported is the honest reading of one. The second wore the first's
 * sentence. A scheme list that is not a list, or a member of one that is not a word, was filtered
 * down to nothing and reported to an administrator as an app Composio published no authentication
 * scheme for — and an unsupported app is HIDDEN from the picker, so the answer nobody could act on
 * was also the answer nobody could see. A managed list that stopped being readable is worse than
 * quiet: the app keeps its place in the picker and drops a rank, so an app whose consent screen
 * asks a person for nothing starts asking them to go and find a key instead.
 */
test("a scheme list this deployment cannot read is refused rather than read as an app publishing none", () => {
  const unreadable = [
    // The schemes the app offers, which stopped being a list.
    { slug: "mystery", auth_schemes: "API_KEY" },
    // One member of it, which stopped being the word it is matched against.
    { slug: "mystery", auth_schemes: [{ name: "API_KEY" }] },
    // And the managed list, which decides the one flow that asks a person for nothing.
    {
      slug: "mystery",
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: "OAUTH2",
    },
  ];

  for (const row of unreadable) {
    expect(() => connectionOf(row)).toThrow(BrokerRefusalError);
    // Nobody's setting is wrong here, so the remedy named is the upgrade rather than a dashboard.
    expect(() => connectionOf(row)).toThrow(/@composio\/core/);
  }
});

/**
 * A MANAGED SCHEME IS READ RATHER THAN COUNTED, WHICH IS WHAT "CONSENT" ACTUALLY CLAIMS.
 *
 * `consent` means one thing: this deployment creates a Composio-managed config and sends the person
 * to a page. The only schemes that have such a page are the ones Composio itself calls redirectable
 * — `RedirectableAuthSchemeSchema` is `z.enum(['OAUTH1', 'OAUTH2'])` (`@composio/core` 0.18.1,
 * `src/types/connectedAccountAuthStates.types.ts:15-18`) — so a managed list holding anything else
 * is not a consent this deployment can run. Deciding on the LENGTH of that list sent every one of
 * them down it, to a link mint with nowhere to send anybody.
 */
test("a managed scheme that redirects nowhere is not a consent flow", () => {
  expect(
    connectionOf({
      slug: "drifted",
      auth_schemes: ["ZZZ"],
      composio_managed_auth_schemes: ["ZZZ"],
    }).kind,
  ).toBe("unsupported");
});

test("a key Composio manages is still a key the person types, not a page they visit", () => {
  expect(
    connectionOf({
      slug: "managed_key",
      auth_schemes: ["API_KEY"],
      composio_managed_auth_schemes: ["API_KEY"],
    }),
  ).toEqual({ kind: "fields", authScheme: "API_KEY" });
});

test("OAuth1 is a consent screen too, because Composio calls it redirectable", () => {
  expect(
    connectionOf({
      slug: "oauth1_app",
      auth_schemes: ["OAUTH1"],
      composio_managed_auth_schemes: ["OAUTH1"],
    }),
  ).toEqual({ kind: "consent" });
});

/**
 * `no_auth` IS AN OPTIONAL FLAG AND `NO_AUTH` IS THE SCHEME ITSELF.
 *
 * A toolkit that publishes the scheme without the flag is one Composio refuses an auth config for
 * exactly as firmly — that refusal is about the toolkit rather than about which field said so. Read
 * only through the flag it became `unsupported`, whose sentence tells an administrator the app
 * wants an OAuth application registered here, and `routes.ts` then drops it from the picker
 * entirely: an app that needs nothing at all, hidden, under a reason that was never true of it.
 */
test("an app publishing NO_AUTH without the flag needs no authentication either", () => {
  expect(
    connectionOf({
      slug: "flagless",
      auth_schemes: ["NO_AUTH"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "no-auth" });
});

test("NO_AUTH beside a managed consent is still no authentication at all", () => {
  expect(
    connectionOf({
      slug: "flagless_managed",
      auth_schemes: ["NO_AUTH", "OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "no-auth" });
});

/**
 * "UNSUPPORTED" AND "UNREADABLE" ARE TWO ANSWERS, AND ONLY ONE OF THEM IS ABOUT THE APP.
 *
 * `unsupported` is a finished verdict: this deployment has nowhere to hold an OAuth client, the
 * reason says so, and `routes.ts` hides the app because nobody should press Add on it. A row whose
 * shape this file cannot read supports none of that — the app may want nothing at all, or a key
 * somebody already holds — and collapsing it into the verdict removed the app from the picker with
 * no refusal recorded anywhere for an operator to read. Every shape below is PRESENT and is not
 * what the row declares it to be, which is the same split `appOf` makes over the rest of the row:
 * an absent field is an answer, a malformed one is a refusal.
 */
const UNREADABLE_SHAPES: { what: string; row: Record<string, unknown> }[] = [
  { what: "a no_auth that is a string", row: { no_auth: "true" } },
  { what: "a no_auth that is a number", row: { no_auth: 1 } },
  {
    what: "auth_schemes that is a bare string",
    row: { auth_schemes: "OAUTH2" },
  },
  { what: "auth_schemes that is an object", row: { auth_schemes: {} } },
  {
    what: "an auth_schemes entry that is not a name",
    row: { auth_schemes: ["OAUTH2", 7] },
  },
  {
    what: "an auth_schemes entry that is blank",
    row: { auth_schemes: ["OAUTH2", "  "] },
  },
  {
    what: "managed schemes that are a bare string",
    row: { composio_managed_auth_schemes: "OAUTH2" },
  },
  {
    what: "a managed schemes entry that is not a name",
    row: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [null] },
  },
];

for (const shape of UNREADABLE_SHAPES) {
  test(`${shape.what} is refused rather than read as an unsupported app`, () => {
    let raised: unknown;
    try {
      connectionOf({ slug: "drifted", ...shape.row });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(BrokerRefusalError);
    expect((raised as Error).message).toContain("drifted");
    expect((raised as Error).message).toContain("@composio/core");
  });
}

/**
 * WHICH FIELD SCHEME AN APP OFFERING TWO OF THEM GETS, WHICH NOTHING HERE USED TO DECIDE.
 *
 * Every fixture above offers at most one, so `FIELD_SCHEME_ORDER` was a table this suite ran past
 * without reading: reversing its comparator left all nine tests green, and the app that offers both
 * a plain key and a JWT-shaped one would quietly have started asking for the harder of the two. The
 * pairs below are ADJACENT in the order, so a comparator running the other way fails every one of
 * them rather than only the one that happens to straddle the middle.
 */
const SCHEME_PAIRS: { offered: string[]; preferred: string }[] = [
  { offered: ["BEARER_TOKEN", "API_KEY"], preferred: "API_KEY" },
  { offered: ["BASIC", "BEARER_TOKEN"], preferred: "BEARER_TOKEN" },
  { offered: ["BASIC_WITH_JWT", "BASIC"], preferred: "BASIC" },
];

for (const pair of SCHEME_PAIRS) {
  test(`an app offering ${pair.offered.join(" and ")} asks for ${pair.preferred}`, () => {
    expect(
      connectionOf({
        slug: "two_ways",
        auth_schemes: pair.offered,
        composio_managed_auth_schemes: [],
      }),
    ).toEqual({ kind: "fields", authScheme: pair.preferred });
  });
}

test("an app offering every field scheme asks for the one a person already holds", () => {
  expect(
    connectionOf({
      slug: "every_way",
      auth_schemes: ["BASIC_WITH_JWT", "BASIC", "BEARER_TOKEN", "API_KEY"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "fields", authScheme: "API_KEY" });
});
