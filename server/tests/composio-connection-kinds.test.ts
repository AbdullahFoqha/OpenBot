import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import {
  BrokerRefusalError,
  type ComposioBroker,
  SCHEME_KINDS,
  type SchemeKind,
  schemeKind,
} from "../src/plugins/broker";
import type { ComposioActions } from "../src/plugins/composio";
import { useComposioClient } from "../src/plugins/composio";
import { connectionOf } from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  BROKERED_PROBE_OUTCOMES,
  type BrokeredProbe,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

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

/**
 * `no_auth` DECIDES THE WHOLE FLOW, AND `=== true` CANNOT TELL ITS ABSENCE FROM ITS WRONG SHAPE.
 *
 * An absent flag reading as "this app needs authenticating" is the benign default and stays. A
 * PRESENT `"true"` reading the same way is Composio saying the opposite of what is read: the app
 * needs nothing, Composio REFUSES an authorization config for exactly such a toolkit, and every
 * enable of it therefore fails against a vendor that already said why. Coercing the string instead
 * would be guessing — `"false"` is truthy, so the coercion that rescues this row flags every app
 * beside it as needing no auth at all, which is the dangerous direction.
 */
test("a no_auth flag Composio sent as a string is refused rather than read as a no", () => {
  expect(() =>
    connectionOf({
      slug: "hackernews",
      no_auth: "true",
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toThrow(/sent a string where its flag saying whether hackernews needs/);
});

/** And an app that publishes no flag at all is still read at the default rather than refused. */
test("an app publishing no no_auth flag is read as one that needs authenticating", () => {
  expect(
    connectionOf({
      slug: "docusign",
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "consent" });
});

/**
 * THE FLAG ON ITS OWN, WHICH IS THE HALF OF THE RECOGNITION THE FIXTURES ABOVE CANNOT REACH.
 *
 * Both no_auth cases above publish `NO_AUTH` in `auth_schemes` AND carry the flag, which is how the
 * live rows really look — and it means either half of `flagged || offered.includes(NO_AUTH_SCHEME)`
 * satisfies them alone. Deleting the flag read left every one of them green, and the flag is the
 * half with no other reader: `flagOf` refuses a `no_auth` it cannot understand precisely because
 * that field decides the whole flow, and a deployment that then never acted on the value it went to
 * the trouble of refusing over would send an app Composio REFUSES a config for down the form flow
 * or the consent flow instead.
 *
 * SO THE ROWS BELOW CARRY THE FLAG AND NOT THE SCHEME, which is the shape a catalogue reaches the
 * day Composio stops listing `NO_AUTH` beside the boolean — it is an optional member of an optional
 * list, and nothing in the vendor's publication holds the two together. The pair at "an app
 * publishing NO_AUTH without the flag" is this the other way round, and between them the two halves
 * of the recognition are each asserted alone.
 */
test("the flag alone needs no authentication, whatever key the app lists beside it", () => {
  expect(
    connectionOf({
      slug: "flagged",
      no_auth: true,
      auth_schemes: ["API_KEY"],
      composio_managed_auth_schemes: [],
    }),
  ).toEqual({ kind: "no-auth" });
});

test("the flag alone beats a managed consent, with no NO_AUTH scheme to say so twice", () => {
  expect(
    connectionOf({
      slug: "flagged_managed",
      no_auth: true,
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
    }),
  ).toEqual({ kind: "no-auth" });
});

/**
 * AND THE UNSUPPORTED SENTENCE NAMES THE MANAGED WORDS, WHICH ARE THE ONES NOTHING ELSE READS.
 *
 * A managed list of schemes that do not redirect is the commonest way to reach `unsupported`, and
 * the app's own `auth_schemes` may be empty beside it — so a reason built from that list alone tells
 * an administrator Composio published NO authentication scheme for an app that published one this
 * deployment simply cannot drive. Every other unsupported fixture here offers the same word in both
 * lists, so dropping the managed half of the reason changed no sentence any of them read, and the
 * one sentence an administrator is given about this app said the opposite of what the row holds.
 */
test("the reason for an unsupported app names what only the managed list published", () => {
  const connection = connectionOf({
    slug: "managed_only",
    auth_schemes: [],
    composio_managed_auth_schemes: ["ZZZ"],
  });

  expect(connection.kind).toBe("unsupported");
  expect(connection.kind === "unsupported" && connection.reason).toContain(
    "ZZZ",
  );
  // And not the sentence written for an app that published nothing at all, which this is not.
  expect(connection.kind === "unsupported" && connection.reason).not.toContain(
    "published no authentication scheme",
  );
});

/**
 * A SCHEME IS THE TRIMMED WORD, BECAUSE EVERY DECISION ABOVE IS A COMPARISON AGAINST A LITERAL.
 *
 * `textOf` trims and nothing asserted that the trimmed value is what `labelsOf` hands back rather
 * than the raw entry it was read from. Returning the raw one keeps every fixture above green — they
 * are all spelled without padding — and turns a `" OAUTH2 "` the wire wrapped into a word matching
 * no literal at all: the app falls out of the consent arm, out of the field arm and out of the
 * no-auth arm, and lands in `unsupported`, which `routes.ts` hides from the picker entirely. The
 * scheme is also RECORDED on the app's row when somebody enables it, so the padded word would
 * outlive the read that let it through.
 *
 * ONE CASE PER ARM, because each arm compares against a different list and a trim that survived in
 * one of them would leave the other two reading an app nobody can connect.
 */
const PADDED_SCHEMES: {
  what: string;
  row: Record<string, unknown>;
  connection: unknown;
}[] = [
  {
    what: "a key",
    row: { auth_schemes: ["  API_KEY  "], composio_managed_auth_schemes: [] },
    connection: { kind: "fields", authScheme: "API_KEY" },
  },
  {
    what: "a managed consent",
    row: {
      auth_schemes: [" OAUTH2 "],
      composio_managed_auth_schemes: [" OAUTH2 "],
    },
    connection: { kind: "consent" },
  },
  {
    what: "no authentication at all",
    row: { auth_schemes: [" NO_AUTH "], composio_managed_auth_schemes: [] },
    connection: { kind: "no-auth" },
  },
];

for (const padded of PADDED_SCHEMES) {
  test(`${padded.what} Composio padded is still ${padded.what}`, () => {
    expect(connectionOf({ slug: "padded", ...padded.row })).toEqual(
      padded.connection,
    );
  });
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY MEMBER OF EVERY CLOSED VOCABULARY, AGAINST EVERY CONSUMER THAT HAS TO DECIDE ON IT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A TABLE AND NOT MORE TESTS. Three rounds of review on this branch each landed a fix that was
 * correct for the case it named and left an adjacent case of the same behaviour standing, thirteen
 * times over. The cause is not carelessness: this branch introduced two finite vocabularies —
 * {@link SCHEME_KINDS} and {@link BROKERED_PROBE_OUTCOMES} — and then consumed both with `if`
 * chains and boolean tests. `kind === "consent"`, `kind !== "key"`, `outcome === "refused"`,
 * `isFieldScheme(authScheme)`. Not one of those has an opinion about the answer it was not written
 * for, so a member nobody named is not a failure anywhere; it is silence. A suite of one test per
 * FINDING inherits that shape exactly, because a finding is one cell.
 *
 * SO THE ROWS ARE READ OFF THE PRODUCTION ROSTERS rather than listed here a second time, which is
 * the discipline `composio-adapter.test.ts` already applies to the vendor seam ("reads the method
 * list off the built objects rather than restating it, so a new seam method cannot be covered by
 * nobody"). A member added to either vocabulary arrives in {@link SCHEME_KINDS} or
 * {@link BROKERED_PROBE_OUTCOMES}, and the completeness tests below fail for every consumer that
 * has no cell for it. The compiler says the same thing one layer up and says it first: each
 * consumer carries a `Decides<…>` roster beside its branch, and a fourth member fails `tsc` at
 * every one of them by name. This table is what the compiler cannot check — what each consumer
 * actually DOES with the member, asserted against the running code.
 *
 * THE TWO CONTESTED CELLS ARE DECLARED AND NOT ASSERTED, WHICH IS THE POINT OF HAVING THEM HERE.
 * `confirmBrokeredConnection × consent` and `the connect route × unreadable` are each claimed by an
 * open finding on this branch; the behaviour they have today is the behaviour those findings exist
 * to change. Asserting it would pin the defect, and omitting the cell would leave the hole
 * invisible — which is the whole failure this table is a lever against. So each is named, with the
 * finding that claims it, and {@link declaredCells} holds the two to being exactly two: the fix
 * cycle that closes one and does not flip its cell to an assertion reddens here.
 */

/**
 * A DATABASE, BECAUSE FIVE OF THE SEVEN CONSUMERS BELOW DECIDE BY READING A ROW.
 *
 * Everything above this line is about {@link connectionOf}, which is a pure read of what Composio
 * publishes. Everything below is about the OTHER half of the same vocabulary: the scheme that read
 * recorded on `mcp_servers.auth_scheme`, and what each consumer of that column then does. Those
 * consumers resolve the row through `brokeredAppRow`, so a stub of the database would be a stub of
 * the thing under test.
 *
 * EVERY ID CARRIES THIS RUN'S SUFFIX, for `composio-connections.test.ts`' reason: these tests run
 * against the shared development database, so a fixture at a fixed id cannot coexist with a real
 * row at that id, and a run that died before its cleanup would redden the file for everybody.
 */
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const person = `user_kinds_${suite}`;

/**
 * ONE APP PER MEMBER, recorded with the literal a real enable would have written for that member.
 *
 * `unreadable` IS A NULL COLUMN, which is the commonest way to reach that member and an ordinary
 * row rather than a corrupt one: `mcp_servers.url` carries no unique index, a row may have been
 * inserted by hand or restored from a deployment that knew other names, and `auth_scheme` is
 * nullable for exactly that reason. {@link OTHER_LITERAL} carries the second way in.
 */
const APP: Record<
  SchemeKind,
  { slug: string; id: string; recorded: string | null }
> = {
  key: {
    slug: `kinds-key-${suite}`,
    id: `composio-kinds-key-${suite}`,
    recorded: "API_KEY",
  },
  consent: {
    slug: `kinds-consent-${suite}`,
    id: `composio-kinds-consent-${suite}`,
    recorded: "OAUTH2",
  },
  unreadable: {
    slug: `kinds-unreadable-${suite}`,
    id: `composio-kinds-unreadable-${suite}`,
    recorded: null,
  },
};

/**
 * A SECOND LITERAL PER MEMBER, so no cell below rests on one spelling of its member.
 *
 * The `consent` entry is what earns this column its keep: `NO_AUTH` is a consent-kind scheme by
 * `schemeKind`, and TWO of the consumers below single it out by comparing that raw string instead
 * of asking the classifier. A member whose consumers disagree INSIDE the member is exactly the
 * drift a one-literal-per-member table would report as agreement.
 */
const OTHER_LITERAL: Record<SchemeKind, string> = {
  key: "BEARER_TOKEN",
  consent: "NO_AUTH",
  unreadable: "SOMETHING_THIS_DEPLOYMENT_NEVER_WRITES",
};

/** The no-auth app, which is a `consent` member that two of the consumers answer differently. */
const NO_AUTH_APP = {
  slug: `kinds-noauth-${suite}`,
  id: `composio-kinds-noauth-${suite}`,
};

/**
 * A KEY APP WITH NOTHING SAFE TO CALL, which is an ordinary app and not a broken one.
 *
 * Most key-based apps in the live catalogue publish some argument-less read; PostHog publishes
 * none. It is what the `nothing` outcome of {@link BROKERED_PROBE_OUTCOMES} is reached through, and
 * it has to be a KEY app to get there — every other scheme is refused before a probe is chosen.
 */
const NO_PROBE_APP = {
  slug: `kinds-noprobe-${suite}`,
  id: `composio-kinds-noprobe-${suite}`,
};

/** The Bot a brokered call is made as, which is the only way to reach the per-person gate. */
const botId = `agent_kinds_${suite}`;
const admin = "admin@openbot.local";

const APP_IDS = [
  ...Object.values(APP).map((app) => app.id),
  NO_AUTH_APP.id,
  NO_PROBE_APP.id,
];
const TOOLKITS = [
  ...Object.values(APP).map((app) => app.slug),
  NO_AUTH_APP.slug,
  NO_PROBE_APP.slug,
];

/** The one action the key app publishes, which is what a probe may be spent on. */
const PROBE_ACTION = "KINDS_WHOAMI";
const PROBE_VERSION = "20260903_00";

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** The vault, and every method loud: nothing on these paths reads a credential of ours. */
const credentialsStub: CredentialSecretReader & CredentialStore = {
  readSecret: async () => {
    throw new Error("a brokered call reads no credential");
  },
  create: async () => {
    throw new Error("this suite writes no credentials");
  },
  updateSecret: async () => {
    throw new Error("this suite writes no credentials");
  },
  rotate: async () => {
    throw new Error("this suite writes no credentials");
  },
  revoke: async () => {
    throw new Error("this suite mints no credential to revoke");
  },
  isLive: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
  findLiveByKey: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
};

/** What the broker was asked, so "the vendor was told" is an assertion and not a guess. */
let brokerAsks: string[] = [];

const broker: ComposioBroker = {
  listApps: async () => {
    throw new Error("nothing here lists the catalogue");
  },
  ensureAuthConfig: async () => {
    throw new Error("nothing here enables an app");
  },
  authorize: async (request) => {
    brokerAsks.push(`authorize:${request.toolkit}`);
    return { redirectUrl: `https://composio.test/${request.toolkit}/consent` };
  },
  isConnected: async (request) => {
    brokerAsks.push(`isConnected:${request.toolkit}/${request.userId}`);
    return true;
  },
  revoke: async (request) => {
    brokerAsks.push(`revoke:${request.toolkit}/${request.userId}`);
    return true;
  },
  deleteAuthConfig: async () => {
    throw new Error("nothing here removes an app");
  },
  connectionFields: async (request) => {
    brokerAsks.push(`connectionFields:${request.toolkit}`);
    return [
      {
        name: "generic_api_key",
        label: "API key",
        help: "The key this app issued you.",
        required: true,
        secret: true,
      },
    ];
  },
  connectWithFields: async (request) => {
    brokerAsks.push(`connectWithFields:${request.toolkit}/${request.userId}`);
    return { accountId: `ca_kinds_${suite}` };
  },
  revokeAccount: async (accountId) => {
    brokerAsks.push(`revokeAccount:${accountId}`);
  },
};

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  broker,
  credentials: credentialsStub,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

/** Signed in as the one person every cell below acts as. */
function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: person,
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

/**
 * The connect route over the SAME store the store cells use, rather than over a stub of it.
 *
 * The fork under test reads `serverAddress`, which resolves the scheme through the one row that
 * answers for the app — so a stub answering a scheme directly would be answering the question the
 * cell exists to ask. Everything else the route needs is configured, so no cell below can reach a
 * refusal about a missing setting instead of the one it is about.
 */
const connectApp = new Hono().route(
  "/api/plugins",
  createPluginRoutes(
    store,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      personHasAccess: async () => true,
    },
    { broker },
  ),
);

async function connectPress(
  serverId: string,
  body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await connectApp.request(
    `http://t/api/plugins/servers/${serverId}/connect`,
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        },
  );
  return {
    status: response.status,
    payload: (await response.json()) as Record<string, unknown>,
  };
}

/** An app row as an enable leaves one, under whatever literal the caller is asking about. */
async function seedApp(
  id: string,
  slug: string,
  recorded: string | null,
): Promise<void> {
  await database.insert(mcpServers).values({
    id,
    title: `Kinds ${slug}`,
    vendor: "Composio",
    url: `composio://${slug}`,
    provenance: "composio",
    ...(recorded === null ? {} : { authScheme: recorded }),
  });
}

/** The key app's one safe read, which is what makes a probe reach the vendor at all. */
async function publishProbe(serverId: string): Promise<void> {
  await database.insert(mcpTools).values({
    serverId,
    name: PROBE_ACTION,
    description: "Says who the key belongs to.",
    effect: "read",
    version: PROBE_VERSION,
  });
}

/** What this deployment believes the person holds, out of this run's apps only. */
async function recordedHere(): Promise<string[]> {
  const rows = await database
    .select({
      toolkit: composioConnections.toolkit,
      verified: composioConnections.verified,
      probeAction: composioConnections.probeAction,
    })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.userId, person),
        inArray(composioConnections.toolkit, TOOLKITS),
      ),
    );
  return rows.map(
    (row) => `${row.toolkit}:${row.verified}:${row.probeAction ?? "null"}`,
  );
}

async function clean(): Promise<void> {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(mcpTools).where(inArray(mcpTools.serverId, APP_IDS));
  await database.delete(mcpServers).where(inArray(mcpServers.id, APP_IDS));
  await database
    .delete(composioConnections)
    .where(inArray(composioConnections.toolkit, TOOLKITS));
}

beforeEach(async () => {
  await clean();
  brokerAsks = [];
  reached = [];
  await database.insert(agents).values({
    id: botId,
    name: "Kinds Helper",
    type: "built_in",
    configuration: {},
  });
  for (const app of Object.values(APP)) {
    await seedApp(app.id, app.slug, app.recorded);
  }
  await seedApp(NO_AUTH_APP.id, NO_AUTH_APP.slug, "NO_AUTH");
  await seedApp(NO_PROBE_APP.id, NO_PROBE_APP.slug, "API_KEY");
  /*
   * THE ACTION IS PUBLISHED ON EVERY APP BUT ONE, so that the gate cell and the probe cells are
   * about what they claim. The gate needs a granted action on each kind of app — otherwise a call
   * would be refused for having nothing to call rather than for having no connection — and the
   * probe cells need the key app to have one. {@link NO_PROBE_APP} is the deliberate exception.
   */
  for (const id of [
    ...Object.values(APP).map((app) => app.id),
    NO_AUTH_APP.id,
  ]) {
    await publishProbe(id);
    await store.grant("mcp", `${id}/${PROBE_ACTION}`, botId, admin);
  }
});

afterEach(() => useComposioClient(null));

afterAll(async () => {
  await clean();
});

/** Every action Composio was asked to run, so "nothing reached the vendor" is an assertion. */
let reached: string[] = [];

/** A Composio that answers everything, so a refusal in a cell is always this deployment's. */
function useAnsweringClient(actions: Partial<ComposioActions> = {}): void {
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return { data: {}, error: null, successful: true };
    },
    ...actions,
  });
}

/** What a refusal said, without a cell having to know which error class carried it. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("nothing was refused, so there is no sentence to read");
}

/**
 * ONE CELL: what a consumer does with one member, and how that is established.
 *
 * TWO SHAPES AND NOT AN OPTIONAL ASSERTION, because "this cell has no assertion" and "this cell's
 * assertion is claimed by an open finding" are the two states that have to be told apart. An
 * optional field makes an omission look exactly like a declaration, which is the failure this whole
 * table is a lever against — at one level up.
 */
type Cell =
  | { decides: string; assert: () => Promise<void> }
  | { decides: string; claimedBy: string };

/** One consumer's answer for every member of one vocabulary. */
type Consumer<Member extends string> = {
  /** The name a reader would grep for. */
  name: string;
  cells: Record<Member, Cell>;
};

/**
 * The seven consumers that have to decide on a {@link SchemeKind}, and what each one does.
 *
 * SEVEN AND NOT SIX, because the classifier is one of them. `schemeKind` is the only consumer whose
 * job is to PRODUCE every member, and a member the classifier can never answer is a member the
 * other six can never be asked about — a hole that would leave every other row in this table
 * trivially green. It is the first row for that reason.
 *
 * THREE OF THE SIX DO NOT ASK THE CLASSIFIER, which is the finding this table records rather than
 * hides. The per-person gate compares the raw literal `NO_AUTH`; the connect route compares that
 * literal and then asks {@link isFieldScheme}; `connectBrokeredWithFields` asks `isFieldScheme`
 * alone. So their cells are about a member whose name they never learn, and the `consent` cells of
 * the first two say out loud that the member is answered two different ways INSIDE itself.
 */
const SCHEME_CONSUMERS: Consumer<SchemeKind>[] = [
  {
    name: "schemeKind, the classifier the other six ought to ask",
    cells: {
      key: {
        decides: "answers `key` for every scheme whose secret a person types",
        assert: async () => {
          expect(schemeKind(APP.key.recorded)).toBe("key");
          expect(schemeKind(OTHER_LITERAL.key)).toBe("key");
        },
      },
      consent: {
        decides:
          "answers `consent` for both consent flows and for NO_AUTH, which has nothing to try either",
        assert: async () => {
          expect(schemeKind(APP.consent.recorded)).toBe("consent");
          expect(schemeKind(OTHER_LITERAL.consent)).toBe("consent");
        },
      },
      unreadable: {
        decides:
          "answers `unreadable` for a null column and for any literal nothing here writes",
        assert: async () => {
          expect(schemeKind(APP.unreadable.recorded)).toBe("unreadable");
          expect(schemeKind(OTHER_LITERAL.unreadable)).toBe("unreadable");
        },
      },
    },
  },
  {
    name: "the per-person gate in connectionTokenFor, reached through callTool",
    cells: {
      key: {
        decides:
          "demands a connection row, and nothing reaches the vendor without one",
        assert: async () => {
          useAnsweringClient();
          expect(
            await refusalOf(
              store.callTool({
                ref: `${APP.key.id}/${PROBE_ACTION}`,
                args: {},
                botId,
                actorId: person,
              }),
            ),
          ).toMatch(/have not connected/i);
          expect(reached).toEqual([]);
        },
      },
      consent: {
        decides:
          "demands a connection row for OAUTH2 — but NOT for the NO_AUTH literal, which this gate exempts by comparing the raw string instead of asking the classifier",
        assert: async () => {
          useAnsweringClient();
          expect(
            await refusalOf(
              store.callTool({
                ref: `${APP.consent.id}/${PROBE_ACTION}`,
                args: {},
                botId,
                actorId: person,
              }),
            ),
          ).toMatch(/have not connected/i);
          expect(reached).toEqual([]);

          /*
           * THE SAME MEMBER, THE OTHER LITERAL, AND THE OPPOSITE ANSWER. This is the whole reason
           * the gate is in this table: one member of the vocabulary, two behaviours, decided by a
           * string comparison that a fourth member would not disturb and that no reader of
           * `schemeKind` would predict.
           */
          await store.callTool({
            ref: `${NO_AUTH_APP.id}/${PROBE_ACTION}`,
            args: {},
            botId,
            actorId: person,
          });
          expect(reached).toEqual([PROBE_ACTION]);
        },
      },
      unreadable: {
        decides:
          "demands a connection row, which is the closed direction and the right one",
        assert: async () => {
          useAnsweringClient();
          expect(
            await refusalOf(
              store.callTool({
                ref: `${APP.unreadable.id}/${PROBE_ACTION}`,
                args: {},
                botId,
                actorId: person,
              }),
            ),
          ).toMatch(/have not connected/i);
          expect(reached).toEqual([]);
        },
      },
    },
  },
  {
    name: "confirmBrokeredConnection, the one consumer that WRITES on a page load",
    cells: {
      key: {
        decides:
          "records a new row as unchecked — a key nothing has ever tried — and leaves an existing one exactly as it is",
        assert: async () => {
          await store.confirmBrokeredConnection({
            toolkit: APP.key.slug,
            userId: person,
          });
          expect(await recordedHere()).toEqual([`${APP.key.slug}:false:null`]);
        },
      },
      consent: {
        decides:
          "records the vendor's yes as a verification, and re-stamps verified_at over an already-consented row on every mount",
        claimedBy:
          "round 3 finding 1-2 #2 — confirm re-stamps verified_at on the consent arm, destroying the consent date recheckBrokeredConnection fails closed to protect",
      },
      unreadable: {
        decides:
          "treated as a key app is: a new row is recorded unchecked, and an existing one is left exactly as it is rather than claimed verified",
        assert: async () => {
          await store.confirmBrokeredConnection({
            toolkit: APP.unreadable.slug,
            userId: person,
          });
          expect(await recordedHere()).toEqual([
            `${APP.unreadable.slug}:false:null`,
          ]);

          // And the second half, which is the one that fails closed: a row already here is not
          // overwritten with a verdict about evidence nobody has.
          await store.confirmBrokeredConnection({
            toolkit: APP.unreadable.slug,
            userId: person,
          });
          expect(await recordedHere()).toEqual([
            `${APP.unreadable.slug}:false:null`,
          ]);
        },
      },
    },
  },
  {
    name: "connectBrokeredWithFields",
    cells: {
      key: {
        decides:
          "connects at the vendor with what was typed, then checks the key it was just handed",
        assert: async () => {
          useAnsweringClient();
          expect(
            await store.connectBrokeredWithFields({
              toolkit: APP.key.slug,
              userId: person,
              values: { generic_api_key: "never-sent-anywhere" },
            }),
          ).toEqual({
            connected: true,
            verified: true,
            probe: PROBE_ACTION,
          });
        },
      },
      consent: {
        decides:
          "refuses — not an app this deployment connects with values somebody types — for OAUTH2 and for NO_AUTH alike",
        assert: async () => {
          for (const slug of [APP.consent.slug, NO_AUTH_APP.slug]) {
            expect(
              await refusalOf(
                store.connectBrokeredWithFields({
                  toolkit: slug,
                  userId: person,
                  values: { generic_api_key: "never-sent-anywhere" },
                }),
              ),
            ).toMatch(/not an app this deployment connects with values/);
          }
          expect(brokerAsks).toEqual([]);
        },
      },
      unreadable: {
        decides:
          "the same refusal, reached by elimination rather than by decision — isFieldScheme is asked and schemeKind is not",
        assert: async () => {
          expect(
            await refusalOf(
              store.connectBrokeredWithFields({
                toolkit: APP.unreadable.slug,
                userId: person,
                values: { generic_api_key: "never-sent-anywhere" },
              }),
            ),
          ).toMatch(/not an app this deployment connects with values/);
          expect(brokerAsks).toEqual([]);
        },
      },
    },
  },
  {
    name: "recheckBrokeredConnection",
    cells: {
      key: {
        decides: "spends a call against the key this deployment already holds",
        assert: async () => {
          useAnsweringClient();
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.key.slug, userId: person });
          expect(
            await store.recheckBrokeredConnection({
              toolkit: APP.key.slug,
              userId: person,
            }),
          ).toMatchObject({ verified: true, probe: PROBE_ACTION });
        },
      },
      consent: {
        decides:
          "refuses — there is no key here to re-check — for OAUTH2 and for NO_AUTH alike, and spends nothing",
        assert: async () => {
          useAnsweringClient();
          for (const slug of [APP.consent.slug, NO_AUTH_APP.slug]) {
            await database
              .insert(composioConnections)
              .values({ toolkit: slug, userId: person });
            expect(
              await refusalOf(
                store.recheckBrokeredConnection({
                  toolkit: slug,
                  userId: person,
                }),
              ),
            ).toMatch(/is not an app this deployment holds a key for/);
          }
          expect(reached).toEqual([]);
        },
      },
      unreadable: {
        decides:
          "the same refusal, which is the closed direction: there is no key recorded to re-check",
        assert: async () => {
          useAnsweringClient();
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.unreadable.slug, userId: person });
          expect(
            await refusalOf(
              store.recheckBrokeredConnection({
                toolkit: APP.unreadable.slug,
                userId: person,
              }),
            ),
          ).toMatch(/is not an app this deployment holds a key for/);
          expect(reached).toEqual([]);
        },
      },
    },
  },
  {
    name: "disconnectBrokered, and what it may claim on the trail",
    cells: {
      key: {
        decides:
          "claims NO vendor revocation: there is no grant behind an API key for anybody to withdraw",
        assert: async () => {
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.key.slug, userId: person });
          expect(
            await store.disconnectBrokered({
              toolkit: APP.key.slug,
              userId: person,
              by: person,
              reason: "self",
            }),
          ).toEqual({ vendorRevocationRequested: false });
        },
      },
      consent: {
        decides:
          "reports the vendor's own withdrawal as asked for, which is a real request for a consent account",
        assert: async () => {
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.consent.slug, userId: person });
          expect(
            await store.disconnectBrokered({
              toolkit: APP.consent.slug,
              userId: person,
              by: person,
              reason: "self",
            }),
          ).toEqual({ vendorRevocationRequested: true });
        },
      },
      unreadable: {
        decides:
          "reports it as asked for too — an app this deployment cannot say holds a key is one whose withdrawal it has to report as asked",
        assert: async () => {
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.unreadable.slug, userId: person });
          expect(
            await store.disconnectBrokered({
              toolkit: APP.unreadable.slug,
              userId: person,
              by: person,
              reason: "self",
            }),
          ).toEqual({ vendorRevocationRequested: true });
        },
      },
    },
  },
  {
    name: "the connect route's fork, POST /servers/:id/connect",
    cells: {
      key: {
        decides:
          "answers with the form the app publishes, and never sends anybody at a consent screen",
        assert: async () => {
          const pressed = await connectPress(APP.key.id);
          expect(pressed.status).toBe(200);
          expect(pressed.payload).toHaveProperty("fields");
          expect(brokerAsks).toEqual([`connectionFields:${APP.key.slug}`]);
        },
      },
      consent: {
        decides:
          "mints a link at Composio for OAUTH2 — and refuses the NO_AUTH literal with the fact about it, which is the one arm this fork reaches by comparing a raw string",
        assert: async () => {
          const consented = await connectPress(APP.consent.id);
          expect(consented.status).toBe(200);
          expect(consented.payload).toHaveProperty("authorizationUrl");

          const noAuth = await connectPress(NO_AUTH_APP.id);
          expect(noAuth.status).toBe(400);
          expect(String(noAuth.payload.error)).toMatch(/needs no account/);
          // And the refusal cost nothing at the vendor, which is half of what makes it a refusal.
          expect(brokerAsks).toEqual([`authorize:${APP.consent.slug}`]);
        },
      },
      unreadable: {
        decides:
          "mints a link at Composio too, reached by elimination: this route imports isFieldScheme and not schemeKind, so the consent arm is the fall-through",
        claimedBy:
          "round 3 findings 1-3 #1 / 2-3 #2 — the connect route still reaches consent by elimination while the store beneath it fails closed on a scheme nothing can read",
      },
    },
  },
];

/**
 * The two consumers that have to decide on a {@link BrokeredProbe} outcome, and what each one does.
 *
 * BOTH OF THEM READ IT FOUR WAYS AND NEITHER OF THEM IS EXHAUSTIVE, which is the same shape as the
 * scheme table above and the reason `unreachable` could be added in round two with the screen above
 * these two still drawing it with another case's sentence. What separates the two consumers is what
 * they may do about a bad answer: the connect made the account seconds ago and undoes it, the
 * re-check found one days old and must not.
 */
const PROBE_CONSUMERS: Consumer<BrokeredProbe["outcome"]>[] = [
  {
    name: "connectBrokeredWithFields, which may undo the account it just made",
    cells: {
      nothing: {
        decides:
          "the account stands, recorded unchecked with a null probe — the app published nothing safe to try",
        assert: async () => {
          useAnsweringClient();
          expect(
            await store.connectBrokeredWithFields({
              toolkit: NO_PROBE_APP.slug,
              userId: person,
              values: { generic_api_key: "never-sent-anywhere" },
            }),
          ).toEqual({ connected: true, verified: false, probe: null });
          expect(await recordedHere()).toEqual([
            `${NO_PROBE_APP.slug}:false:null`,
          ]);
          expect(reached).toEqual([]);
        },
      },
      answered: {
        decides:
          "the account stands, recorded verified under the probe's own name",
        assert: async () => {
          useAnsweringClient();
          expect(
            await store.connectBrokeredWithFields({
              toolkit: APP.key.slug,
              userId: person,
              values: { generic_api_key: "never-sent-anywhere" },
            }),
          ).toEqual({
            connected: true,
            verified: true,
            probe: PROBE_ACTION,
          });
          expect(await recordedHere()).toEqual([
            `${APP.key.slug}:true:${PROBE_ACTION}`,
          ]);
        },
      },
      refused: {
        decides:
          "the account it just made is withdrawn BY ID, and the press is refused in the vendor's own words",
        assert: async () => {
          useAnsweringClient({
            execute: async ({ slug }) => {
              reached.push(slug);
              return {
                data: {},
                error: "that key is not valid for this workspace",
                successful: false,
              };
            },
          });
          expect(
            await refusalOf(
              store.connectBrokeredWithFields({
                toolkit: APP.key.slug,
                userId: person,
                values: { generic_api_key: "never-sent-anywhere" },
              }),
            ),
          ).toMatch(/not valid for this workspace/);
          expect(brokerAsks).toContain(`revokeAccount:ca_kinds_${suite}`);
          // Nothing is left behind claiming a connection that was undone.
          expect(await recordedHere()).toEqual([]);
        },
      },
      unreachable: {
        decides:
          "the account stands, recorded unchecked with a NULL probe — the name is withheld, so no row can accuse a key nobody reached",
        assert: async () => {
          useAnsweringClient({
            execute: async () => {
              throw new Error("Composio was not reachable");
            },
          });
          expect(
            await store.connectBrokeredWithFields({
              toolkit: APP.key.slug,
              userId: person,
              values: { generic_api_key: "never-sent-anywhere" },
            }),
          ).toEqual({ connected: true, verified: false, probe: null });
          expect(await recordedHere()).toEqual([`${APP.key.slug}:false:null`]);
          // And the account is NOT withdrawn: an outage is not evidence against a key.
          expect(brokerAsks).not.toContain(`revokeAccount:ca_kinds_${suite}`);
        },
      },
    },
  },
  {
    name: "recheckBrokeredConnection, which must never undo the account it is checking",
    cells: {
      nothing: {
        decides:
          "writes nothing and files nothing; answers the held row beside a null probe that says why the press could not improve on it",
        assert: async () => {
          useAnsweringClient();
          await database
            .insert(composioConnections)
            .values({ toolkit: NO_PROBE_APP.slug, userId: person });
          expect(
            await store.recheckBrokeredConnection({
              toolkit: NO_PROBE_APP.slug,
              userId: person,
            }),
          ).toEqual({ verified: false, verifiedAt: null, probe: null });
          expect(await recordedHere()).toEqual([
            `${NO_PROBE_APP.slug}:false:null`,
          ]);
        },
      },
      answered: {
        decides: "records verified under the probe's name",
        assert: async () => {
          useAnsweringClient();
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.key.slug, userId: person });
          expect(
            await store.recheckBrokeredConnection({
              toolkit: APP.key.slug,
              userId: person,
            }),
          ).toMatchObject({ verified: true, probe: PROBE_ACTION });
          expect(await recordedHere()).toEqual([
            `${APP.key.slug}:true:${PROBE_ACTION}`,
          ]);
        },
      },
      refused: {
        decides:
          "records unchecked under the probe's name and then refuses — the account is left standing, because it is the key that is wrong",
        assert: async () => {
          useAnsweringClient({
            execute: async ({ slug }) => {
              reached.push(slug);
              return {
                data: {},
                error: "that key is not valid for this workspace",
                successful: false,
              };
            },
          });
          await database
            .insert(composioConnections)
            .values({ toolkit: APP.key.slug, userId: person });
          expect(
            await refusalOf(
              store.recheckBrokeredConnection({
                toolkit: APP.key.slug,
                userId: person,
              }),
            ),
          ).toMatch(/would not answer with the key it is holding/);
          expect(await recordedHere()).toEqual([
            `${APP.key.slug}:false:${PROBE_ACTION}`,
          ]);
          expect(brokerAsks).toEqual([]);
        },
      },
      unreachable: {
        decides:
          "writes nothing and files nothing; refuses with Composio's own sentence, and the row is left exactly as the last check left it",
        assert: async () => {
          useAnsweringClient({
            execute: async () => {
              throw new Error("Composio was not reachable");
            },
          });
          await database.insert(composioConnections).values({
            toolkit: APP.key.slug,
            userId: person,
            verified: true,
            probeAction: PROBE_ACTION,
          });
          expect(
            await refusalOf(
              store.recheckBrokeredConnection({
                toolkit: APP.key.slug,
                userId: person,
              }),
            ),
          ).toMatch(/could not be checked just now/);
          expect(await recordedHere()).toEqual([
            `${APP.key.slug}:true:${PROBE_ACTION}`,
          ]);
        },
      },
    },
  },
];

/**
 * EVERY CELL DECLARED RATHER THAN ASSERTED, WITH THE FINDING THAT CLAIMS IT.
 *
 * Held to being exactly these two. A fix cycle that closes one of these holes and does not flip its
 * cell from a declaration to an assertion reddens here — which is the half a `test.todo` or a
 * commented-out case cannot do, because both of those stay quiet whether or not the thing they
 * describe is still true. A THIRD declaration appearing is the same failure the other way round:
 * somebody has decided a cell is contested, and this is where that decision is visible.
 */
const DECLARED_CELLS = [
  "confirmBrokeredConnection, the one consumer that WRITES on a page load × consent",
  "the connect route's fork, POST /servers/:id/connect × unreadable",
];

function declaredCellsOf(consumers: Consumer<string>[]): string[] {
  return consumers.flatMap((consumer) =>
    Object.entries(consumer.cells)
      .filter(([, cell]) => "claimedBy" in cell)
      .map(([member]) => `${consumer.name} × ${member}`),
  );
}

describe.each(SCHEME_KINDS)("a %s scheme", (kind) => {
  for (const consumer of SCHEME_CONSUMERS) {
    const cell = consumer.cells[kind];
    if ("claimedBy" in cell) {
      test(`${consumer.name} — DECLARED, not asserted: ${cell.decides}`, () => {
        // The declaration IS the assertion here: this cell names an open finding, and the sentence
        // above records what the code does today so the next reader can tell the two apart.
        expect(cell.claimedBy).not.toBe("");
        expect(DECLARED_CELLS).toContain(`${consumer.name} × ${kind}`);
      });
      continue;
    }
    test(`${consumer.name} ${cell.decides}`, cell.assert);
  }
});

describe.each(BROKERED_PROBE_OUTCOMES)("a probe that %s", (outcome) => {
  for (const consumer of PROBE_CONSUMERS) {
    const cell = consumer.cells[outcome];
    if ("claimedBy" in cell) {
      test(`${consumer.name} — DECLARED, not asserted: ${cell.decides}`, () => {
        expect(cell.claimedBy).not.toBe("");
        expect(DECLARED_CELLS).toContain(`${consumer.name} × ${outcome}`);
      });
      continue;
    }
    test(`${consumer.name} ${cell.decides}`, cell.assert);
  }
});

/**
 * THE COMPLETENESS HALF, WHICH IS WHAT MAKES THE TABLE A LEVER RATHER THAN A LIST.
 *
 * The rows are read off the production rosters, so a member added to either vocabulary arrives here
 * and every consumer with no cell for it fails BY NAME. That is the same discipline
 * `composio-adapter.test.ts` applies to the vendor seam, and it is the runtime half of the
 * compile-time witnesses: `tsc` names the consumers whose `Decides<…>` roster is short, and this
 * names the consumers whose behaviour nobody wrote down.
 */
describe("the vocabularies are covered by name and not by accident", () => {
  test("every consumer of a scheme kind has a cell for every member", () => {
    for (const consumer of SCHEME_CONSUMERS) {
      expect(Object.keys(consumer.cells).sort()).toEqual(
        [...SCHEME_KINDS].sort(),
      );
    }
  });

  test("every consumer of a probe outcome has a cell for every member", () => {
    for (const consumer of PROBE_CONSUMERS) {
      expect(Object.keys(consumer.cells).sort()).toEqual(
        [...BROKERED_PROBE_OUTCOMES].sort(),
      );
    }
  });

  test("the cells that are declared rather than asserted are exactly the ones an open finding claims", () => {
    expect(
      [
        ...declaredCellsOf(SCHEME_CONSUMERS),
        ...declaredCellsOf(PROBE_CONSUMERS),
      ].sort(),
    ).toEqual([...DECLARED_CELLS].sort());
  });

  /**
   * AND EVERY MEMBER IS ONE THE CLASSIFIER CAN ACTUALLY PRODUCE, which is the hole a table of
   * consumers cannot see on its own. A member no recorded value ever classifies to is a member every
   * row above is trivially green for: the cell would be written, the assertion would pass, and
   * nothing would ever reach it. The fixtures are the witness, so a member added without one fails
   * here rather than being covered by a test that cannot run.
   */
  test("every scheme kind is reachable from a value the column may really hold", () => {
    const reachable = new Set(
      [
        ...Object.values(APP).map((app) => app.recorded),
        ...Object.values(OTHER_LITERAL),
      ].map((recorded) => schemeKind(recorded)),
    );
    expect([...reachable].sort()).toEqual([...SCHEME_KINDS].sort());
  });
});
