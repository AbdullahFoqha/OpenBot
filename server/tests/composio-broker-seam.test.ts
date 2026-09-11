import { describe, expect, test } from "bun:test";
import {
  BrokerReturnUrlError,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
} from "../src/plugins/broker";

/**
 * The broker seam's three decisions, asserted with no network and no database.
 *
 * Most of `./broker` is a type, which a type checker settles and a test cannot. What is left to
 * assert is the runtime facts the module exists to fix: what an unconfigured deployment says about
 * itself, what it refuses to say about anything else, and which return addresses it will not begin
 * a consent against.
 *
 * The second of those is the one worth a file. `brokerSentence` is what a caller reaches for when a
 * broker call throws, and the tempting shape — a fallback sentence for anything it does not
 * recognise — would report a missing setting for a vendor outage: an operator told to set
 * `COMPOSIO_API_KEY` when the key is set and Composio's socket hung up. Null is how the function
 * declines to guess, and the caller is left to say something true about the failure it actually has.
 */

describe("brokerSentence", () => {
  test("reports the unconfigured deployment in the error's own words", () => {
    const error = new BrokerUnconfiguredError();

    expect(error.message).toContain("COMPOSIO_API_KEY");
    expect(brokerSentence(error)).toBe(error.message);
  });

  test("declines to explain a failure that is not about configuration", () => {
    expect(brokerSentence(new Error("socket hang up"))).toBeNull();
  });
});

/**
 * The return address, which is the one value on this seam a type cannot settle.
 *
 * `authorize`'s `returnUrl` is documented as required and spelled `string`, and `""`, `"   "` and
 * `openbot.example.com/settings/...` all satisfy that: they reach Composio as a callback nobody
 * returns through, and the person who finds out is the one who has just granted a third party
 * access to their mailbox. The route assembles the address at run time from `OPENBOT_APP_URL`, an
 * unvalidated environment string, so `string` really is the strongest promise it can make and the
 * check belongs here rather than in the type.
 *
 * Each refusal is asserted by the half of its sentence that only it says. Both name
 * `OPENBOT_APP_URL`, because both are fixed there, so a test that asked only for the setting would
 * pass just as well if the two branches collapsed into one — and they are two different mistakes:
 * an address nobody built, and a configured one that cannot work.
 */
describe("brokerReturnUrl", () => {
  test("refuses an address that was never built", () => {
    expect(() => brokerReturnUrl("")).toThrow(/built no address/);
    expect(() => brokerReturnUrl("   ")).toThrow(/built no address/);
    expect(() => brokerReturnUrl("")).toThrow(BrokerReturnUrlError);
  });

  test("refuses an address no browser could come back through", () => {
    for (const unusable of [
      "openbot.example.com/settings/connected-accounts/x",
      "localhost:3001/settings/connected-accounts/x",
      "/settings/connected-accounts/x",
      "javascript:alert(1)",
    ]) {
      expect(() => brokerReturnUrl(unusable)).toThrow(/not a web address/);
    }
  });

  test("says which setting fixes it, and never quotes the address", () => {
    let thrown: unknown;
    try {
      brokerReturnUrl("openbot.example.com/settings/connected-accounts/x");
    } catch (error) {
      thrown = error;
    }

    const sentence = brokerSentence(thrown);
    expect(sentence).toContain("OPENBOT_APP_URL");
    expect(sentence).not.toContain("/settings/connected-accounts/x");
  });

  test("hands back the address a configured deployment built", () => {
    expect(
      brokerReturnUrl("https://openbot.test/settings/connected-accounts/x"),
    ).toBe("https://openbot.test/settings/connected-accounts/x");
    expect(brokerReturnUrl("http://localhost:3001/admin/plugins/x")).toBe(
      "http://localhost:3001/admin/plugins/x",
    );
  });
});
