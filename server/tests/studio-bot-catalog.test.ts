import { describe, expect, test } from "bun:test";
import {
  BUILTIN_BOT_IDS,
  isBuiltinBotId,
  validateBotId,
} from "../src/studio/bot-catalog";

describe("validateBotId", () => {
  test("accepts kebab slug", () => {
    expect(validateBotId("custom-researcher-demo").ok).toBe(true);
  });
  test("rejects uppercase / underscore / leading digit", () => {
    expect(validateBotId("Custom").ok).toBe(false);
    expect(validateBotId("a_b").ok).toBe(false);
    expect(validateBotId("1abc").ok).toBe(false);
  });
  test("rejects built-in collision", () => {
    for (const id of BUILTIN_BOT_IDS) {
      const r = validateBotId(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("built-in");
    }
  });
});

describe("isBuiltinBotId", () => {
  test("studio-lead is builtin", () => {
    expect(isBuiltinBotId("studio-lead")).toBe(true);
  });
  test("custom is not", () => {
    expect(isBuiltinBotId("custom-researcher-demo")).toBe(false);
  });
});

describe("catalog merge contract", () => {
  test("builtin list is non-empty and stable", () => {
    expect(BUILTIN_BOT_IDS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(BUILTIN_BOT_IDS).size).toBe(BUILTIN_BOT_IDS.length);
  });
});
