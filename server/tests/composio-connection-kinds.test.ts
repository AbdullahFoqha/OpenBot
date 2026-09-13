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
