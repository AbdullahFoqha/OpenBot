import { describe, expect, test } from "bun:test";
import { handoffToolParameters } from "../src/agents/handoff-tool";

describe("P1.1 message_bot priority param", () => {
  test("accepts priority true/false", () => {
    const a = handoffToolParameters.safeParse({
      bot: "custom-researcher-demo",
      task: "say hi",
      priority: true,
    });
    const b = handoffToolParameters.safeParse({
      bot: "custom-researcher-demo",
      task: "fyi",
      priority: false,
    });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});
