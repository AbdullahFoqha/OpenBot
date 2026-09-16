import { describe, expect, test } from "bun:test";

describe("studio bot secrets P2.4", () => {
  test("env-style name pattern", () => {
    const re = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
    expect(re.test("CURSOR_API_KEY")).toBe(true);
    expect(re.test("penpot-token")).toBe(false);
    expect(re.test("1BAD")).toBe(false);
  });

  test("list payload never carries value fields", () => {
    const meta = {
      id: "sec-1",
      botId: "studio-lead",
      name: "FOO",
      hasValue: true as const,
    };
    expect("value" in meta).toBe(false);
    expect("plaintext" in meta).toBe(false);
    expect(meta.hasValue).toBe(true);
  });
});
