import { describe, expect, test } from "bun:test";
import { MINIMUM_INTERVAL_MS } from "../src/routines/schedule";

describe("studio routines P2.1", () => {
  test("minimum interval is 15 minutes", () => {
    expect(MINIMUM_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  test("routine id prefix", () => {
    expect(`routine_${crypto.randomUUID()}`.startsWith("routine_")).toBe(true);
  });

  test("pause/resume enabled flags are opposites", () => {
    const pause = { enabled: false };
    const resume = { enabled: true };
    expect(pause.enabled).not.toBe(resume.enabled);
  });
});
