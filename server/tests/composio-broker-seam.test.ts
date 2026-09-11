import { describe, expect, test } from "bun:test";
import { BrokerUnconfiguredError, brokerSentence } from "../src/plugins/broker";

/**
 * The broker seam's two decisions, asserted with no network and no database.
 *
 * Everything else in `./broker` is a type, which a type checker settles and a test cannot. What is
 * left to assert is the pair of runtime facts the module exists to fix: what an unconfigured
 * deployment says about itself, and what it refuses to say about anything else.
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
