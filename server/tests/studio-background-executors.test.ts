import { describe, expect, test } from "bun:test";
import { DEFAULT_STUDIO_POLICY, parseStudioPolicy } from "../src/studio/policy";

describe("studio background executors P2.2", () => {
  test("defaults allow 2 background slots per bot", () => {
    expect(DEFAULT_STUDIO_POLICY.maxPrimaryExecutionTasksPerBot).toBe(1);
    expect(DEFAULT_STUDIO_POLICY.maxBackgroundExecutionTasksPerBot).toBe(2);
    expect(DEFAULT_STUDIO_POLICY.maxActiveExecutionTasks).toBe(3);
  });

  test("policy parses maxBackgroundExecutionTasksPerBot", () => {
    const parsed = parseStudioPolicy({ maxBackgroundExecutionTasksPerBot: 3 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.policy.maxBackgroundExecutionTasksPerBot).toBe(3);
    }
  });
});
