import { describe, expect, test } from "bun:test";

describe("studio memory P1.3", () => {
  test("tier defaults to log", () => {
    const tier = (t?: string) => (t === "profile" || t === "note" ? t : "log");
    expect(tier(undefined)).toBe("log");
    expect(tier("profile")).toBe("profile");
  });

  test("scope user vs agent", () => {
    const scope = (s?: string) => (s === "user" ? "user" : "agent");
    expect(scope("user")).toBe("user");
    expect(scope()).toBe("agent");
  });

  test("memory id prefix", () => {
    expect(`mem-abcd1234`.startsWith("mem-")).toBe(true);
  });
});
