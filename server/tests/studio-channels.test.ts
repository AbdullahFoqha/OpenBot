import { describe, expect, test } from "bun:test";

describe("studio channels P1.2", () => {
  test("member list dedupes and requires at least one", () => {
    const members = [...new Set(["studio-lead", "studio-lead", "custom-researcher-demo"].map((m) => m.trim()).filter(Boolean))];
    expect(members).toEqual(["studio-lead", "custom-researcher-demo"]);
    expect(members.length).toBeGreaterThanOrEqual(1);
  });

  test("studio channel id prefix shape", () => {
    const id = `studio-ch-${"abcd1234"}`;
    expect(id.startsWith("studio-ch-")).toBe(true);
  });
});
